const { pathToFileURL } = require("url");

function registerTextToSpeechTool({ ipcMain, dialog, fs, textToSpeech, getTTSVoices }) {
  const outputs = new Map();
  const busy = new Set();
  ipcMain.handle("tts-tool-generate", async (event, input) => {
    const owner = event.sender.id;
    if (busy.has(owner)) return { success: false, error: "busy" };
    if (!input || typeof input.text !== "string" || !input.text.trim() ||
        input.text.length > 10000 || typeof input.voice !== "string") {
      return { success: false, error: "invalid_input" };
    }
    busy.add(owner);
    try {
      const voices = await getTTSVoices();
      if (!voices.some(voice => voice.ShortName === input.voice)) {
        return { success: false, error: "voices_failed" };
      }
      const result = await textToSpeech(input.text.trim(), input.voice);
      if (!result.success) return { success: false, error: "generation_failed" };
      if (event.sender.isDestroyed()) return { success: false, error: "generation_failed" };
      // Retain only the latest full recording per renderer for saving.
      let recordings = outputs.get(owner);
      if (!recordings) {
        recordings = {};
        outputs.set(owner, recordings);
        event.sender.once("destroyed", () => outputs.delete(owner));
      }
      if (!input.preview) recordings.recording = result.value;
      return { success: true, audioUrl: pathToFileURL(result.value).href };
    } catch (error) {
      console.error("[TextToSpeechTool] Generation failed:", error);
      return { success: false, error: "generation_failed" };
    } finally {
      busy.delete(owner);
    }
  });
  ipcMain.handle("tts-tool-save", async event => {
    const recording = outputs.get(event.sender.id)?.recording;
    if (!recording) return { success: false, error: "no_recording" };
    try {
      const result = await dialog.showSaveDialog({
        defaultPath: "voiceover.mp3",
        filters: [{ name: "MP3 audio", extensions: ["mp3"] }],
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      await fs.copyFile(recording, result.filePath);
      return { success: true };
    } catch (error) {
      console.error("[TextToSpeechTool] Save failed:", error);
      return { success: false, error: "save_failed" };
    }
  });
}

module.exports = { registerTextToSpeechTool };
