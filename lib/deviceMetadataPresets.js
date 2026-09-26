/**
 * Device Metadata Presets Module
 * 
 * Provides realistic EXIF metadata configurations for various smartphone cameras.
 * Used to make AI-generated images appear as if taken by real devices.
 */

const crypto = require('crypto');

/**
 * Device preset definitions with camera specifications
 */
const DEVICE_PRESETS = {
  iphone13promax: {
    id: 'iphone13promax',
    name: 'iPhone 13 Pro Max',
    make: 'Apple',
    model: 'iPhone 13 Pro Max',
    software: '18.6.2',
    hostComputer: 'iPhone 13 Pro Max',
    lensInfo: '1.570000052-9mm f/1.5-2.8',
    lensMake: 'Apple',
    lensModel: 'iPhone 13 Pro Max back triple camera 5.7mm f/1.5',
    focalLength: 5.7,
    focalLengthIn35mm: 26,
    aperture: 1.5,
    isoRange: [50, 2000],
    shutterSpeedRange: [1/8000, 1/4],
    imageWidth: 4032,
    imageHeight: 3024,
    colorSpace: 'Display P3',
    profileDescription: 'Display P3'
  },
  iphone15pro: {
    id: 'iphone15pro',
    name: 'iPhone 15 Pro',
    make: 'Apple',
    model: 'iPhone 15 Pro',
    software: '18.6.2',
    hostComputer: 'iPhone 15 Pro',
    lensInfo: '2.220000029-9mm f/1.78-2.8',
    lensMake: 'Apple',
    lensModel: 'iPhone 15 Pro back triple camera 6.765mm f/1.78',
    focalLength: 6.765,
    focalLengthIn35mm: 24,
    aperture: 1.78,
    isoRange: [50, 3200],
    shutterSpeedRange: [1/8000, 1/4],
    imageWidth: 4032,
    imageHeight: 3024,
    colorSpace: 'Display P3',
    profileDescription: 'Display P3'
  },
  iphone15promax: {
    id: 'iphone15promax',
    name: 'iPhone 15 Pro Max',
    make: 'Apple',
    model: 'iPhone 15 Pro Max',
    software: '18.6.2',
    hostComputer: 'iPhone 15 Pro Max',
    lensInfo: '2.220000029-9mm f/1.78-2.8',
    lensMake: 'Apple',
    lensModel: 'iPhone 15 Pro Max back triple camera 6.765mm f/1.78',
    focalLength: 6.765,
    focalLengthIn35mm: 24,
    aperture: 1.78,
    isoRange: [50, 3200],
    shutterSpeedRange: [1/8000, 1/4],
    imageWidth: 4032,
    imageHeight: 3024,
    colorSpace: 'Display P3',
    profileDescription: 'Display P3'
  },
  iphone14: {
    id: 'iphone14',
    name: 'iPhone 14',
    make: 'Apple',
    model: 'iPhone 14',
    software: '18.6.2',
    hostComputer: 'iPhone 14',
    lensInfo: '1.539999962-4.25mm f/1.5-2.4',
    lensMake: 'Apple',
    lensModel: 'iPhone 14 back dual wide camera 5.7mm f/1.5',
    focalLength: 5.7,
    focalLengthIn35mm: 26,
    aperture: 1.5,
    isoRange: [50, 2000],
    shutterSpeedRange: [1/8000, 1/4],
    imageWidth: 4032,
    imageHeight: 3024,
    colorSpace: 'Display P3',
    profileDescription: 'Display P3'
  },
  samsungs24ultra: {
    id: 'samsungs24ultra',
    name: 'Samsung Galaxy S24 Ultra',
    make: 'samsung',
    model: 'SM-S928B',
    software: 'S928BXXS3AXB1',
    hostComputer: null,
    lensInfo: null,
    lensMake: null,
    lensModel: null,
    focalLength: 6.3,
    focalLengthIn35mm: 23,
    aperture: 1.7,
    isoRange: [50, 3200],
    shutterSpeedRange: [1/8000, 1/4],
    imageWidth: 4000,
    imageHeight: 3000,
    colorSpace: 'sRGB',
    profileDescription: 'sRGB IEC61966-2.1'
  },
  pixel8pro: {
    id: 'pixel8pro',
    name: 'Google Pixel 8 Pro',
    make: 'Google',
    model: 'Pixel 8 Pro',
    software: 'husky-user 15 AP4A.250305.002 12957054 release-keys',
    hostComputer: null,
    lensInfo: null,
    lensMake: null,
    lensModel: null,
    focalLength: 6.9,
    focalLengthIn35mm: 24,
    aperture: 1.68,
    isoRange: [50, 6400],
    shutterSpeedRange: [1/8000, 1/4],
    imageWidth: 4080,
    imageHeight: 3072,
    colorSpace: 'sRGB',
    profileDescription: 'sRGB IEC61966-2.1'
  }
};

/**
 * Get a device preset by ID
 * @param {string} presetId - The preset identifier
 * @returns {Object|null} The preset configuration or null if not found
 */
function getPreset(presetId) {
  return DEVICE_PRESETS[presetId] || null;
}

/**
 * Get all available presets
 * @returns {Array<{id: string, name: string}>} Array of preset info
 */
function listPresets() {
  return Object.values(DEVICE_PRESETS).map(p => ({
    id: p.id,
    name: p.name
  }));
}

/**
 * Generate a random number within a range
 * @param {number} min 
 * @param {number} max 
 * @returns {number}
 */
function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Generate a random integer within a range
 * @param {number} min 
 * @param {number} max 
 * @returns {number}
 */
function randomIntInRange(min, max) {
  return Math.floor(randomInRange(min, max + 1));
}

/**
 * Generate a random point within a circle
 * @param {number} centerLat - Center latitude
 * @param {number} centerLng - Center longitude
 * @param {number} radiusMeters - Radius in meters
 * @returns {{lat: number, lng: number}}
 */
function randomPointInCircle(centerLat, centerLng, radiusMeters) {
  // Random angle and radius (use sqrt for uniform distribution)
  const angle = Math.random() * 2 * Math.PI;
  const radius = Math.sqrt(Math.random()) * radiusMeters;
  
  // Convert meters to degrees (approximate)
  // 1 degree latitude ≈ 111,320 meters
  // 1 degree longitude ≈ 111,320 * cos(latitude) meters
  const latOffset = (radius * Math.cos(angle)) / 111320;
  const lngOffset = (radius * Math.sin(angle)) / (111320 * Math.cos(centerLat * Math.PI / 180));
  
  return {
    lat: centerLat + latOffset,
    lng: centerLng + lngOffset
  };
}

/**
 * Generate a random timestamp within the last N days
 * @param {number} days - Number of days to go back (default 7)
 * @returns {Date}
 */
function randomTimestamp(days = 7) {
  const now = Date.now();
  const minTime = now - (days * 24 * 60 * 60 * 1000);
  const randomTime = minTime + Math.random() * (now - minTime);
  return new Date(randomTime);
}

/**
 * Format a date for EXIF (YYYY:MM:DD HH:MM:SS)
 * @param {Date} date 
 * @returns {string}
 */
function formatExifDate(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Format GPS date (YYYY:MM:DD)
 * @param {Date} date 
 * @returns {string}
 */
function formatGpsDate(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())}`;
}

/**
 * Generate timezone offset string (e.g., +01:00)
 * @returns {string}
 */
function getTimezoneOffset() {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? '+' : '-';
  const hours = Math.floor(Math.abs(offset) / 60).toString().padStart(2, '0');
  const minutes = (Math.abs(offset) % 60).toString().padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

/**
 * Convert decimal degrees to degrees, minutes, seconds
 * @param {number} decimal - Decimal degrees
 * @returns {Array<Array<number>>} Array of [numerator, denominator] pairs for degrees, minutes, seconds
 */
function decimalToDMS(decimal) {
  const abs = Math.abs(decimal);
  const degrees = Math.floor(abs);
  const minutesDecimal = (abs - degrees) * 60;
  const minutes = Math.floor(minutesDecimal);
  const seconds = (minutesDecimal - minutes) * 60;
  
  // Return as [degrees, minutes, seconds] each as [numerator, denominator] rational
  return [
    [degrees, 1],
    [minutes, 1],
    [Math.round(seconds * 100), 100]
  ];
}

/**
 * Generate a UUID for photo identifier
 * @returns {string}
 */
function generatePhotoId() {
  return crypto.randomUUID().toUpperCase();
}

/**
 * Generate complete metadata configuration based on preset and options
 * @param {string} presetId - Device preset ID
 * @param {Object} options - Additional options
 * @param {Object} options.gps - GPS configuration {enabled, center: {lat, lng}, radius}
 * @param {Object} options.customFields - Custom field overrides
 * @param {number} options.timestampDays - Days to randomize timestamp (default 7)
 * @returns {Object} Complete EXIF metadata object
 */
function generateMetadata(presetId, options = {}) {
  const preset = getPreset(presetId);
  if (!preset) {
    console.error(`[DeviceMetadata] Unknown preset: ${presetId}`);
    return null;
  }
  
  const {
    gps = { enabled: false },
    customFields = {},
    timestampDays = 7
  } = options;
  
  // Generate random timestamp
  const timestamp = randomTimestamp(timestampDays);
  const exifDate = formatExifDate(timestamp);
  const timezoneOffset = getTimezoneOffset();
  const subsec = randomIntInRange(100, 999).toString();
  
  // Generate random camera settings within realistic ranges
  const iso = randomIntInRange(preset.isoRange[0], Math.min(preset.isoRange[1], 800)); // Keep ISO realistic (not too high)
  const shutterSpeed = randomInRange(1/500, 1/30); // Common outdoor/indoor range
  const brightnessValue = randomInRange(2, 8);
  const exposureCompensation = randomInRange(-0.67, 0.67);
  
  // Generate random subject area (face detection area, typical for iPhones)
  // Format: [center X, center Y, width, height] - represents the focus area
  const subjectAreaX = randomIntInRange(Math.round(preset.imageWidth * 0.3), Math.round(preset.imageWidth * 0.7));
  const subjectAreaY = randomIntInRange(Math.round(preset.imageHeight * 0.3), Math.round(preset.imageHeight * 0.6));
  const subjectAreaW = randomIntInRange(500, 900);
  const subjectAreaH = randomIntInRange(500, 900);
  
  // Base metadata
  const metadata = {
    // EXIF IFD
    make: customFields.make || preset.make,
    model: customFields.model || preset.model,
    orientation: 1, // Normal (or 6 for Rotate 90 CW which is common on phones)
    xResolution: [72, 1],
    yResolution: [72, 1],
    resolutionUnit: 2, // inches
    software: customFields.software || preset.software,
    modifyDate: exifDate,
    hostComputer: preset.hostComputer,
    yCbCrPositioning: 1, // Centered
    
    // EXIF SubIFD
    exposureTime: [1, Math.round(1 / shutterSpeed)],
    fNumber: [Math.round(preset.aperture * 10), 10],
    exposureProgram: 2, // Program AE
    iso: iso,
    exifVersion: '0232',
    dateTimeOriginal: exifDate,
    dateTimeDigitized: exifDate,
    offsetTime: timezoneOffset,
    offsetTimeOriginal: timezoneOffset,
    offsetTimeDigitized: timezoneOffset,
    shutterSpeedValue: [Math.round(Math.log2(1 / shutterSpeed) * 100), 100],
    apertureValue: [Math.round(Math.log2(preset.aperture * preset.aperture) * 100), 100],
    brightnessValue: [Math.round(brightnessValue * 1000000), 1000000],
    exposureBiasValue: [Math.round(exposureCompensation * 1000), 1000],
    meteringMode: 3, // Spot
    flash: 0x10, // Off, Did not fire
    focalLength: [Math.round(preset.focalLength * 10), 10],
    subjectArea: [subjectAreaX, subjectAreaY, subjectAreaW, subjectAreaH], // Focus area
    subSecTimeOriginal: subsec,
    subSecTimeDigitized: subsec,
    flashPixVersion: '0100',
    colorSpace: 65535, // Uncalibrated (for Display P3) or 1 for sRGB
    exifImageWidth: preset.imageWidth,
    exifImageHeight: preset.imageHeight,
    sensingMethod: 2, // One-chip color area
    sceneType: 1, // Directly photographed
    exposureMode: 0, // Auto
    whiteBalance: 0, // Auto
    focalLengthIn35mmFormat: preset.focalLengthIn35mm,
    sceneCaptureType: 0, // Standard
    lensInfo: customFields.lensInfo || preset.lensInfo,
    lensMake: customFields.lensMake || preset.lensMake,
    lensModel: customFields.lensModel || preset.lensModel,
    compositeImage: 2, // General Composite Image
    
    // Additional metadata for realism
    photoIdentifier: generatePhotoId(),
    
    // Image dimensions
    imageWidth: preset.imageWidth,
    imageHeight: preset.imageHeight
  };
  
  // Add GPS data if enabled
  if (gps.enabled && gps.center && gps.center.lat !== undefined && gps.center.lng !== undefined) {
    const radius = gps.radius || 1000; // Default 1km
    const point = randomPointInCircle(gps.center.lat, gps.center.lng, radius);
    
    // Generate random altitude (sea level to 500m above)
    const altitude = randomInRange(0, 500);
    
    metadata.gps = {
      latitudeRef: point.lat >= 0 ? 'N' : 'S',
      latitude: decimalToDMS(point.lat),
      longitudeRef: point.lng >= 0 ? 'E' : 'W',
      longitude: decimalToDMS(point.lng),
      altitudeRef: 0, // Above sea level
      altitude: [Math.round(altitude * 10), 10],
      timeStamp: [
        [timestamp.getUTCHours(), 1],
        [timestamp.getUTCMinutes(), 1],
        [timestamp.getUTCSeconds(), 1]
      ],
      speedRef: 'K', // km/h
      speed: [0, 1],
      imgDirectionRef: 'T', // True North
      imgDirection: [Math.round(randomInRange(0, 360) * 100), 100],
      destBearingRef: 'T',
      destBearing: [Math.round(randomInRange(0, 360) * 100), 100],
      dateStamp: formatGpsDate(timestamp),
      hPositioningError: [Math.round(randomInRange(5, 50) * 100), 100] // 5-50m accuracy
    };
  }
  
  return metadata;
}

module.exports = {
  DEVICE_PRESETS,
  getPreset,
  listPresets,
  generateMetadata,
  randomPointInCircle,
  randomTimestamp,
  formatExifDate,
  decimalToDMS
};
