const { randomUUID } = require('crypto');
// Serialize read/modify/write so overlapping edits cannot lose another note.
let queue = Promise.resolve();
async function notesOperation(action, value) {
  const run = async () => {
    const { readKey, updateData } = require('./utils');
    const stored = await readKey('localNotes');
    let notes = Array.isArray(stored) ? stored : [];
    if (action === 'get') return { success: true, notes };
    if (action === 'delete') notes = notes.filter(note => String(note.id) !== String(value));
    else {
      const note = {
        id: action === 'create' ? randomUUID() : String(value?.id || ''),
        title: String(value?.title || '').slice(0, 500),
        content: String(value?.content || '').slice(0, 100000),
        color: /^#[0-9a-f]{6}$/i.test(value?.color || '') ? value.color : '#fef3c7',
        updated_at: new Date().toISOString(),
      };
      if (action === 'create') notes.unshift({ ...note, created_at: note.updated_at });
      else {
        const index = notes.findIndex(item => String(item.id) === note.id);
        if (index < 0) return { success: false, error: 'Note not found' };
        notes[index] = { ...notes[index], ...note };
      }
      await updateData('localNotes', notes);
      return { success: true, noteId: note.id };
    }
    await updateData('localNotes', notes);
    return { success: true };
  };
  const result = queue.then(run);
  queue = result.catch(() => {});
  return result;
}
module.exports = { notesOperation };
