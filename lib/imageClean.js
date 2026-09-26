/**
 * Image Cleaning Module
 * 
 * Strips embedded image metadata and optionally applies light pixel processing.
 * This sanitizes file-level provenance data but does not change how the image was
 * created or guarantee the result of any third-party AI-image classifier.
 * 
 * Techniques used:
 * - Remove all EXIF, XMP, IPTC, and C2PA Content Credentials metadata
 * - Re-encode image to change byte-level signatures
 * - Apply subtle blur + sharpen as optional pixel resampling
 * - Random micro-crop and resize to alter pixel grid alignment
 * - Optional: Inject fake device metadata (iPhone, Samsung, etc.)
 */

const sharp = require('sharp');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exiftool } = require('exiftool-vendored');
const { generateMetadata, getPreset } = require('./deviceMetadataPresets');
const { humanizeBuffer } = require('./humanizeImage');

/**
 * Inject fake EXIF metadata into a JPEG buffer using exiftool
 * This function writes comprehensive metadata matching real iPhone photos
 * 
 * @param {Buffer} jpegBuffer - JPEG image buffer
 * @param {Object} metadataConfig - Metadata configuration from generateMetadata()
 * @returns {Promise<Buffer>} JPEG buffer with injected metadata
 */
async function injectExifMetadata(jpegBuffer, metadataConfig) {
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `exif_inject_${crypto.randomBytes(8).toString('hex')}.jpg`);
  
  try {
    // Write buffer to temp file
    fs.writeFileSync(tempFile, jpegBuffer);
    
    // Build exiftool tag object matching real iPhone metadata structure
    const tags = {};
    
    // === IFD0 (Main Image Tags) ===
    if (metadataConfig.make) tags.Make = metadataConfig.make;
    if (metadataConfig.model) tags.Model = metadataConfig.model;
    // Don't set Orientation - pixels are already correctly oriented after sharp.rotate()
    // Setting Orientation can cause viewers to rotate an already-correct image
    if (metadataConfig.xResolution) {
      tags.XResolution = Array.isArray(metadataConfig.xResolution) 
        ? metadataConfig.xResolution[0] / metadataConfig.xResolution[1] 
        : metadataConfig.xResolution;
    }
    if (metadataConfig.yResolution) {
      tags.YResolution = Array.isArray(metadataConfig.yResolution) 
        ? metadataConfig.yResolution[0] / metadataConfig.yResolution[1] 
        : metadataConfig.yResolution;
    }
    if (metadataConfig.resolutionUnit !== undefined) tags.ResolutionUnit = metadataConfig.resolutionUnit;
    if (metadataConfig.software) tags.Software = metadataConfig.software;
    if (metadataConfig.modifyDate) tags.ModifyDate = metadataConfig.modifyDate;
    if (metadataConfig.hostComputer) tags.HostComputer = metadataConfig.hostComputer;
    if (metadataConfig.yCbCrPositioning !== undefined) tags.YCbCrPositioning = metadataConfig.yCbCrPositioning;
    
    // === EXIF SubIFD Tags ===
    if (metadataConfig.exposureTime) {
      const [num, den] = metadataConfig.exposureTime;
      tags.ExposureTime = num / den;
    }
    if (metadataConfig.fNumber) {
      const [num, den] = metadataConfig.fNumber;
      tags.FNumber = num / den;
    }
    if (metadataConfig.exposureProgram !== undefined) tags.ExposureProgram = metadataConfig.exposureProgram;
    if (metadataConfig.iso !== undefined) tags.ISO = metadataConfig.iso;
    tags.ExifVersion = '0232'; // iPhone uses EXIF 2.32
    if (metadataConfig.dateTimeOriginal) tags.DateTimeOriginal = metadataConfig.dateTimeOriginal;
    if (metadataConfig.dateTimeDigitized) tags.CreateDate = metadataConfig.dateTimeDigitized;
    if (metadataConfig.offsetTime) tags.OffsetTime = metadataConfig.offsetTime;
    if (metadataConfig.offsetTimeOriginal) tags.OffsetTimeOriginal = metadataConfig.offsetTimeOriginal;
    if (metadataConfig.offsetTimeDigitized) tags.OffsetTimeDigitized = metadataConfig.offsetTimeDigitized;
    
    // ComponentsConfiguration - Y, Cb, Cr, - (standard for color JPEG)
    tags.ComponentsConfiguration = '1 2 3 0';
    
    if (metadataConfig.shutterSpeedValue) {
      const [num, den] = metadataConfig.shutterSpeedValue;
      tags.ShutterSpeedValue = num / den;
    }
    if (metadataConfig.apertureValue) {
      const [num, den] = metadataConfig.apertureValue;
      tags.ApertureValue = num / den;
    }
    if (metadataConfig.brightnessValue) {
      const [num, den] = metadataConfig.brightnessValue;
      tags.BrightnessValue = num / den;
    }
    if (metadataConfig.exposureBiasValue) {
      const [num, den] = metadataConfig.exposureBiasValue;
      tags.ExposureCompensation = num / den;
    }
    if (metadataConfig.meteringMode !== undefined) tags.MeteringMode = metadataConfig.meteringMode;
    if (metadataConfig.flash !== undefined) tags.Flash = metadataConfig.flash;
    if (metadataConfig.focalLength) {
      const [num, den] = metadataConfig.focalLength;
      tags.FocalLength = num / den;
    }
    if (metadataConfig.subjectArea) {
      tags.SubjectArea = metadataConfig.subjectArea.join(' ');
    }
    if (metadataConfig.subSecTimeOriginal) tags.SubSecTimeOriginal = metadataConfig.subSecTimeOriginal;
    if (metadataConfig.subSecTimeDigitized) tags.SubSecTimeDigitized = metadataConfig.subSecTimeDigitized;
    tags.FlashpixVersion = '0100';
    if (metadataConfig.colorSpace !== undefined) tags.ColorSpace = metadataConfig.colorSpace;
    if (metadataConfig.exifImageWidth !== undefined) tags.ExifImageWidth = metadataConfig.exifImageWidth;
    if (metadataConfig.exifImageHeight !== undefined) tags.ExifImageHeight = metadataConfig.exifImageHeight;
    if (metadataConfig.sensingMethod !== undefined) tags.SensingMethod = metadataConfig.sensingMethod;
    if (metadataConfig.sceneType !== undefined) tags.SceneType = metadataConfig.sceneType;
    if (metadataConfig.exposureMode !== undefined) tags.ExposureMode = metadataConfig.exposureMode;
    if (metadataConfig.whiteBalance !== undefined) tags.WhiteBalance = metadataConfig.whiteBalance;
    if (metadataConfig.focalLengthIn35mmFormat !== undefined) {
      tags.FocalLengthIn35mmFormat = metadataConfig.focalLengthIn35mmFormat;
    }
    if (metadataConfig.sceneCaptureType !== undefined) tags.SceneCaptureType = metadataConfig.sceneCaptureType;
    
    // Lens Info - parse as 4 values for LensInfo tag
    if (metadataConfig.lensInfo) {
      const lensSpec = parseLensInfoToString(metadataConfig.lensInfo);
      if (lensSpec) tags.LensInfo = lensSpec;
    }
    if (metadataConfig.lensMake) tags.LensMake = metadataConfig.lensMake;
    if (metadataConfig.lensModel) tags.LensModel = metadataConfig.lensModel;
    if (metadataConfig.compositeImage !== undefined) tags.CompositeImage = metadataConfig.compositeImage;
    
    // === SEO Metadata Tags (Title, Keywords, Comments, Rating) ===
    if (metadataConfig.seo) {
      const seo = metadataConfig.seo;
      
      // Title - write to multiple fields for maximum compatibility
      if (seo.title) {
        tags.Title = seo.title;           // XMP-dc:Title
        tags.ObjectName = seo.title;      // IPTC ObjectName
        tags.Headline = seo.title;        // IPTC Headline
        tags.ImageDescription = seo.title; // EXIF ImageDescription
        tags.XPTitle = seo.title;         // Windows Explorer Title
        tags.XPSubject = seo.title;       // Windows Explorer Subject
      }
      
      // Object (same as title per requirements)
      if (seo.object) {
        // ObjectName already set above if title is provided
        // This is explicit support if object differs from title in the future
        if (!seo.title) {
          tags.ObjectName = seo.object;
        }
      }
      
      // Keywords - array of strings, each on separate line
      if (seo.keywords && Array.isArray(seo.keywords) && seo.keywords.length > 0) {
        const keywordsStr = seo.keywords.join('\n'); // One keyword per line
        tags.Keywords = keywordsStr;      // IPTC Keywords (newline separated)
        tags.Subject = keywordsStr;       // XMP-dc:Subject (newline separated)
        tags.XPKeywords = keywordsStr;    // Windows Explorer Keywords (newline separated)
      }
      
      // Rating - 1-5 stars
      if (seo.rating !== undefined && seo.rating !== null) {
        tags.Rating = seo.rating;         // XMP Rating
        tags.RatingPercent = seo.rating * 20; // Windows expects 0-100 scale (5 stars = 100%)
      }
      
      // Comments - write to UserComment and Caption
      if (seo.comments) {
        tags.UserComment = seo.comments;   // EXIF UserComment
        tags['Caption-Abstract'] = seo.comments; // IPTC Caption-Abstract
        tags.Description = seo.comments;   // XMP-dc:Description
        tags.XPComment = seo.comments;     // Windows Explorer Comments
      }
      
      console.log(`[ImageClean] SEO metadata prepared: title="${seo.title?.substring(0, 30)}...", ` +
                  `keywords=${seo.keywords?.length || 0}, rating=${seo.rating}`);
    }
    
    // === GPS Tags ===
    if (metadataConfig.gps) {
      const gps = metadataConfig.gps;
      
      // Convert DMS arrays to decimal degrees for exiftool
      if (gps.latitude && gps.latitudeRef) {
        const lat = dmsToDecimal(gps.latitude);
        tags.GPSLatitude = lat;
        tags.GPSLatitudeRef = gps.latitudeRef;
      }
      if (gps.longitude && gps.longitudeRef) {
        const lng = dmsToDecimal(gps.longitude);
        tags.GPSLongitude = lng;
        tags.GPSLongitudeRef = gps.longitudeRef;
      }
      if (gps.altitudeRef !== undefined) tags.GPSAltitudeRef = gps.altitudeRef === 0 ? 'Above Sea Level' : 'Below Sea Level';
      if (gps.altitude) {
        const [num, den] = gps.altitude;
        tags.GPSAltitude = num / den;
      }
      if (gps.timeStamp) {
        // Format as HH:MM:SS
        const [[h], [m], [s]] = gps.timeStamp;
        tags.GPSTimeStamp = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
      }
      if (gps.speedRef) tags.GPSSpeedRef = gps.speedRef;
      if (gps.speed) {
        const [num, den] = gps.speed;
        tags.GPSSpeed = num / den;
      }
      if (gps.imgDirectionRef) tags.GPSImgDirectionRef = gps.imgDirectionRef;
      if (gps.imgDirection) {
        const [num, den] = gps.imgDirection;
        tags.GPSImgDirection = num / den;
      }
      if (gps.destBearingRef) tags.GPSDestBearingRef = gps.destBearingRef;
      if (gps.destBearing) {
        const [num, den] = gps.destBearing;
        tags.GPSDestBearing = num / den;
      }
      if (gps.dateStamp) tags.GPSDateStamp = gps.dateStamp;
      if (gps.hPositioningError) {
        const [num, den] = gps.hPositioningError;
        tags.GPSHPositioningError = num / den;
      }
    }
    
    // Write metadata using exiftool
    await exiftool.write(tempFile, tags, ['-overwrite_original']);
    
    // Read back the modified file
    const resultBuffer = fs.readFileSync(tempFile);
    
    console.log(`[ImageClean] Injected EXIF via exiftool: Make=${metadataConfig.make}, Model=${metadataConfig.model}, ` +
                `Software=${metadataConfig.software}, GPS=${!!metadataConfig.gps}, SEO=${!!metadataConfig.seo}`);
    
    return resultBuffer;
  } catch (error) {
    console.error('[ImageClean] Error injecting EXIF metadata:', error.message) ;
    // Return original buffer if injection fails
    return jpegBuffer;
  } finally {
    // Cleanup temp file
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Convert DMS (degrees/minutes/seconds as rationals) to decimal degrees
 * @param {Array} dms - Array of 3 rationals [[deg,1], [min,1], [sec,100]]
 * @returns {number} Decimal degrees
 */
function dmsToDecimal(dms) {
  const [[d, dd], [m, md], [s, sd]] = dms;
  return (d / dd) + (m / md) / 60 + (s / sd) / 3600;
}

/**
 * Parse lens info string to exiftool format
 * @param {string} lensInfo - e.g., "1.570000052-9mm f/1.5-2.8"
 * @returns {string|null} Formatted lens info for exiftool
 */
function parseLensInfoToString(lensInfo) {
  try {
    const match = lensInfo.match(/([\d.]+)-([\d.]+)mm f\/([\d.]+)-([\d.]+)/i);
    if (match) {
      return lensInfo; // Return as-is, exiftool handles parsing
    }
  } catch (e) {
    // Fall through
  }
  return lensInfo; // Return original string
}

/**
 * Sanitize image metadata and optionally reprocess its pixels.
 * 
 * @param {Buffer|string} input - Image buffer or file path
 * @param {Object} options - Cleaning options
 * @param {boolean} options.stripMetadata - Remove all metadata (default: true)
 * @param {boolean} options.perturbPixels - Apply subtle blur/sharpen (default: true)
 * @param {boolean} options.microCrop - Apply random 1-2px crop (default: true)
 * @param {number} options.quality - Output quality 1-100 (default: 96)
 * @param {string} options.forceFormat - Force output format: 'png', 'jpeg', 'webp', or null for auto (default: null)
 * @param {boolean} options.humanize - Apply the camera-realism humanization pipeline (default: false)
 * @param {number} options.humanizeIntensity - Global strength multiplier for humanization (default: 1)
 * @param {Object} options.injectMetadata - Metadata injection config (null to skip)
 * @param {boolean} options.injectMetadata.enabled - Whether to inject fake metadata
 * @param {string} options.injectMetadata.preset - Device preset ID (e.g., 'iphone13promax')
 * @param {Object} options.injectMetadata.gps - GPS config {enabled, center: {lat, lng}, radius}
 * @param {Object} options.injectMetadata.customFields - Custom field overrides
 * @returns {Promise<{success: boolean, buffer?: Buffer, format?: string, error?: string}>}
 */
async function cleanImage(input, options = {}) {
  const {
    stripMetadata = true,
    perturbPixels = true,
    microCrop = true,
    quality = 96,
    forceFormat = null,
    humanize = false,
    humanizeIntensity = 1,
    injectMetadata = null
  } = options;

  try {
    let pipeline = sharp(input);
    
    // Get image metadata to check for alpha channel and dimensions
    const metadata = await pipeline.metadata();
    const hasAlpha = metadata.hasAlpha;
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;
    
    // Determine output format
    // If metadata injection is enabled, force JPEG since EXIF can only be injected into JPEG
    // Otherwise: preserve PNG for transparency, use JPEG otherwise unless forced
    let outputFormat = forceFormat;
    if (!outputFormat) {
      if (injectMetadata && injectMetadata.enabled) {
        // Force JPEG for metadata injection (iPhones always produce JPEG)
        outputFormat = 'jpeg';
      } else {
        outputFormat = hasAlpha ? 'png' : 'jpeg';
      }
    }

    // Re-create pipeline (metadata() consumes it)
    pipeline = sharp(input);
    
    // Auto-rotate based on EXIF orientation BEFORE stripping metadata
    // This ensures pixels are correctly oriented regardless of what happens to metadata
    pipeline = pipeline.rotate();

    // 1. Sharp strips metadata by default when producing a new image. Preserve it
    // only when the caller explicitly disables stripping. Do not use
    // withMetadata(false): withMetadata() always calls keepMetadata(), regardless
    // of the value passed, which previously inverted this option's behavior.
    if (!stripMetadata) {
      pipeline = pipeline.keepMetadata();
    }

    // Humanization path: run the camera-realism pipeline instead of the light
    // perturbation/micro-crop. This supersedes steps 2-4 (its own resize trick,
    // blur, sharpen and JPEG re-encode are applied). Fake EXIF injection still
    // runs afterwards if requested. Output is always JPEG.
    if (humanize) {
      // Feed the humanizer a rotated, lossless (PNG) buffer so we don't compress
      // twice. Metadata is stripped by default (sharp drops it on re-encode).
      const preBuffer = await pipeline.png().toBuffer();
      const humanResult = await humanizeBuffer(preBuffer, { intensity: humanizeIntensity });

      if (humanResult.success) {
        let finalBuffer = humanResult.buffer;
        const humanFormat = 'jpeg';

        if (injectMetadata && injectMetadata.enabled) {
          const preset = injectMetadata.preset || 'iphone13promax';
          let gpsConfig = { enabled: false };
          if (injectMetadata.gpsEnabled && injectMetadata.gpsCenter) {
            gpsConfig = {
              enabled: true,
              center: injectMetadata.gpsCenter,
              radius: injectMetadata.gpsRadius || 1000
            };
          } else if (injectMetadata.gps) {
            gpsConfig = injectMetadata.gps;
          }

          const metadataConfig = generateMetadata(preset, {
            gps: gpsConfig,
            customFields: injectMetadata.customFields || {},
            timestampDays: injectMetadata.timestampDays || 7
          });

          if (metadataConfig) {
            metadataConfig.exifImageWidth = originalWidth;
            metadataConfig.exifImageHeight = originalHeight;
            metadataConfig.imageWidth = originalWidth;
            metadataConfig.imageHeight = originalHeight;
            finalBuffer = await injectExifMetadata(humanResult.buffer, metadataConfig);
            console.log(`[ImageClean] Humanized + injected ${preset} metadata (GPS=${gpsConfig.enabled})`);
          }
        }

        console.log(`[ImageClean] Humanized image: ${originalWidth}x${originalHeight} -> jpeg (intensity=${humanizeIntensity})`);
        return {
          success: true,
          buffer: finalBuffer,
          format: humanFormat,
          originalFormat: metadata.format
        };
      }

      // On failure, fall through to the standard cleaning pipeline.
      console.warn('[ImageClean] Humanization failed, falling back to standard cleaning:', humanResult.error);
      pipeline = sharp(input).rotate();
      if (!stripMetadata) pipeline = pipeline.keepMetadata();
    }

    // 2. Apply micro-crop: remove 1-2px from random edges, then resize back
    // This shifts the pixel grid and disrupts alignment-based detection
    if (microCrop && originalWidth > 100 && originalHeight > 100) {
      const cropLeft = crypto.randomInt(0, 3);   // 0-2px
      const cropTop = crypto.randomInt(0, 3);
      const cropRight = crypto.randomInt(0, 3);
      const cropBottom = crypto.randomInt(0, 3);
      
      const newWidth = originalWidth - cropLeft - cropRight;
      const newHeight = originalHeight - cropTop - cropBottom;
      
      if (newWidth > 50 && newHeight > 50) {
        pipeline = pipeline.extract({
          left: cropLeft,
          top: cropTop,
          width: newWidth,
          height: newHeight
        });
        
        // Resize back to original dimensions using high-quality interpolation
        // This re-interpolates all pixels, changing their exact values
        pipeline = pipeline.resize(originalWidth, originalHeight, {
          kernel: 'lanczos3',
          fit: 'fill'
        });
      }
    }

    // 3. Apply subtle pixel resampling. This changes pixel values but is not a
    // guarantee that robust watermarks or classifier-visible features are removed.
    if (perturbPixels) {
      pipeline = pipeline
        .blur(0.3)      // Imperceptible Gaussian blur
        .sharpen({      // Re-sharpen to maintain perceived quality
          sigma: 0.5,
          m1: 0.5,
          m2: 0.5,
          x1: 2,
          y1: 10,
          y2: 20,
          y3: 20
        });
    }

    // 4. Re-encode with specified format and quality
    // This ensures byte-level changes even if no other processing is applied
    if (outputFormat === 'jpeg') {
      // Use settings that match real iPhone JPEG output
      pipeline = pipeline.jpeg({
        quality,
        mozjpeg: false,                // Baseline DCT like iPhone (not Progressive)
        chromaSubsampling: '4:2:0'     // iPhone uses YCbCr 4:2:0, not 4:4:4
      });
    } else if (outputFormat === 'webp') {
      pipeline = pipeline.webp({
        quality,
        effort: 6           // Higher effort = different encoding
      });
    } else {
      // PNG - preserve transparency
      pipeline = pipeline.png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        palette: false       // Don't reduce to palette, keep full color
      });
    }

    const buffer = await pipeline.toBuffer();

    // 5. Inject fake device metadata if enabled (JPEG only)
    let finalBuffer = buffer;
    
    // Debug logging for metadata injection decision
    if (injectMetadata) {
      console.log(`[ImageClean] Metadata injection config: enabled=${injectMetadata.enabled}, format=${outputFormat}, preset=${injectMetadata.preset}`);
    }
    
    if (injectMetadata && injectMetadata.enabled && outputFormat === 'jpeg') {
      const preset = injectMetadata.preset || 'iphone13promax';
      
      // Transform flat settings structure to nested format for generateMetadata
      // Settings from frontend: { gpsEnabled, gpsCenter, gpsRadius }
      // Expected format: { gps: { enabled, center, radius } }
      let gpsConfig = { enabled: false };
      if (injectMetadata.gpsEnabled && injectMetadata.gpsCenter) {
        gpsConfig = {
          enabled: true,
          center: injectMetadata.gpsCenter,
          radius: injectMetadata.gpsRadius || 1000
        };
      } else if (injectMetadata.gps) {
        // Also support nested format for backwards compatibility
        gpsConfig = injectMetadata.gps;
      }
      
      const metadataConfig = generateMetadata(preset, {
        gps: gpsConfig,
        customFields: injectMetadata.customFields || {},
        timestampDays: injectMetadata.timestampDays || 7
      });
      
      if (metadataConfig) {
        // Update dimensions to match actual output
        metadataConfig.exifImageWidth = originalWidth;
        metadataConfig.exifImageHeight = originalHeight;
        metadataConfig.imageWidth = originalWidth;
        metadataConfig.imageHeight = originalHeight;
        
        finalBuffer = await injectExifMetadata(buffer, metadataConfig);
        console.log(`[ImageClean] Injected ${preset} metadata with GPS=${gpsConfig.enabled}`);
      }
    }

    console.log(`[ImageClean] Cleaned image: ${originalWidth}x${originalHeight} -> ${outputFormat}, ` +
                `metadata=${stripMetadata}, perturb=${perturbPixels}, microCrop=${microCrop}`);

    return {
      success: true,
      buffer: finalBuffer,
      format: outputFormat,
      originalFormat: metadata.format
    };
  } catch (error) {
    console.error('[ImageClean] Error cleaning image:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Clean an image from a data URL
 * @param {string} dataUrl - Base64 data URL (data:image/xxx;base64,...)
 * @param {Object} options - Cleaning options (see cleanImage)
 * @returns {Promise<{success: boolean, dataUrl?: string, error?: string}>}
 */
async function cleanDataUrl(dataUrl, options = {}) {
  try {
    // Parse data URL
    const matches = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
      return { success: false, error: 'Invalid data URL format' };
    }

    const inputFormat = matches[1];
    const base64Data = matches[2];
    const inputBuffer = Buffer.from(base64Data, 'base64');

    // Clean the image
    const result = await cleanImage(inputBuffer, options);
    if (!result.success) {
      return result;
    }

    // Convert back to data URL
    const mimeType = result.format === 'jpeg' ? 'image/jpeg' 
                   : result.format === 'webp' ? 'image/webp' 
                   : 'image/png';
    const cleanedDataUrl = `data:${mimeType};base64,${result.buffer.toString('base64')}`;

    return {
      success: true,
      dataUrl: cleanedDataUrl,
      format: result.format
    };
  } catch (error) {
    console.error('[ImageClean] Error cleaning data URL:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Clean an image file and save to a new path
 * @param {string} inputPath - Path to input image
 * @param {string} outputPath - Path for cleaned image output
 * @param {Object} options - Cleaning options (see cleanImage)
 * @returns {Promise<{success: boolean, outputPath?: string, error?: string}>}
 */
async function cleanImageFile(inputPath, outputPath, options = {}) {
  const fs = require('fs').promises;
  
  try {
    const inputBuffer = await fs.readFile(inputPath);
    const result = await cleanImage(inputBuffer, options);
    
    if (!result.success) {
      return result;
    }

    await fs.writeFile(outputPath, result.buffer);
    
    return {
      success: true,
      outputPath,
      format: result.format
    };
  } catch (error) {
    console.error('[ImageClean] Error cleaning image file:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Shutdown exiftool process (call when app is closing)
 */
async function shutdownExiftool() {
  try {
    await exiftool.end();
    console.log('[ImageClean] ExifTool process ended');
  } catch (e) {
    // Ignore errors on shutdown
  }
}

module.exports = {
  cleanImage,
  cleanDataUrl,
  cleanImageFile,
  injectExifMetadata,
  shutdownExiftool
};
