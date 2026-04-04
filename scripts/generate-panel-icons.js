#!/usr/bin/env node

'use strict';

/**
 * Content:
 * Generates panel app icon assets from the shared admin/msghub.png source.
 * System integration:
 * Repo-local utility script with no external image dependencies.
 * Interfaces:
 * Reads admin/msghub.png and writes PNG icon variants for core and generic plugin host panels.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = createCrcTable();

const DEFAULT_SOURCE_PATH = path.resolve(__dirname, '..', 'admin', 'msghub.png');
const TARGETS = [
	{
		baseName: 'messages',
		outputDir: path.resolve(__dirname, '..', 'admin', 'icons', 'messages'),
		overlayGlyph: null,
	},
	{
		baseName: 'pluginUI',
		outputDir: path.resolve(__dirname, '..', 'admin', 'icons', 'pluginUI'),
		overlayGlyph: 'p',
	},
];

const VARIANTS = [
	{ suffix: '192', size: 192, inset: 0, background: null },
	{ suffix: '512', size: 512, inset: 0, background: null },
	{ suffix: 'maskable-192', size: 192, inset: 0.12, background: [255, 255, 255, 255] },
	{ suffix: 'maskable-512', size: 512, inset: 0.12, background: [255, 255, 255, 255] },
	{ suffix: 'apple-180', size: 180, inset: 0.08, background: [255, 255, 255, 255] },
];

/**
 * Executes the generation workflow.
 *
 * @returns {void}
 */
function main() {
	const sourcePath = resolveSourcePath();
	const source = decodePng(fs.readFileSync(sourcePath));
	for (const target of TARGETS) {
		fs.mkdirSync(target.outputDir, { recursive: true });
		for (const variant of VARIANTS) {
			const pixels = renderVariant(source, variant, target);
			const filePath = path.join(target.outputDir, `${target.baseName}-${variant.suffix}.png`);
			fs.writeFileSync(filePath, encodePng(variant.size, variant.size, pixels));
			process.stdout.write(`${path.relative(path.resolve(__dirname, '..'), filePath)}\n`);
		}
	}
}

/**
 * Resolves the icon source path from CLI args or the repo default.
 *
 * @returns {string} Absolute source PNG path.
 */
function resolveSourcePath() {
	const args = process.argv.slice(2);
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === '--source') {
			const candidate = args[index + 1];
			if (!candidate) {
				throw new Error('Missing value for --source');
			}
			return path.resolve(candidate);
		}
	}
	return DEFAULT_SOURCE_PATH;
}

/**
 * Decodes a non-interlaced RGBA PNG.
 *
 * @param {Buffer} input PNG file content.
 * @returns {{ width: number, height: number, pixels: Uint8Array }} Decoded RGBA image data.
 */
function decodePng(input) {
	if (input.length < PNG_SIGNATURE.length || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new Error('Unsupported PNG signature');
	}

	let width = 0;
	let height = 0;
	let idatSize = 0;
	const idatParts = [];
	let offset = 8;

	while (offset < input.length) {
		const length = input.readUInt32BE(offset);
		const type = input.subarray(offset + 4, offset + 8).toString('ascii');
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		const data = input.subarray(dataStart, dataEnd);

		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const bitDepth = data[8];
			const colorType = data[9];
			const compression = data[10];
			const filterMethod = data[11];
			const interlace = data[12];
			if (bitDepth !== 8 || colorType !== 6 || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
				throw new Error('Only non-interlaced 8-bit RGBA PNG files are supported');
			}
		} else if (type === 'IDAT') {
			idatParts.push(data);
			idatSize += data.length;
		} else if (type === 'IEND') {
			break;
		}

		offset = dataEnd + 4;
	}

	if (width <= 0 || height <= 0 || idatParts.length === 0) {
		throw new Error('Incomplete PNG file');
	}

	const compressed = Buffer.concat(idatParts, idatSize);
	const raw = zlib.inflateSync(compressed);
	const bytesPerPixel = 4;
	const stride = width * bytesPerPixel;
	const expected = (stride + 1) * height;
	if (raw.length !== expected) {
		throw new Error('Unexpected PNG payload size');
	}

	const pixels = new Uint8Array(width * height * bytesPerPixel);
	let rawOffset = 0;
	for (let y = 0; y < height; y += 1) {
		const filterType = raw[rawOffset];
		rawOffset += 1;
		const row = pixels.subarray(y * stride, (y + 1) * stride);
		const scanline = raw.subarray(rawOffset, rawOffset + stride);
		unfilterRow(row, scanline, pixels, y, stride, bytesPerPixel, filterType);
		rawOffset += stride;
	}

	return { width, height, pixels };
}

/**
 * Applies the PNG row filter.
 *
 * @param {Uint8Array} row Output row slice.
 * @param {Buffer} scanline Input row data.
 * @param {Uint8Array} pixels Complete pixel buffer.
 * @param {number} y Current row index.
 * @param {number} stride Bytes per row.
 * @param {number} bytesPerPixel Bytes per pixel.
 * @param {number} filterType PNG filter type.
 * @returns {void}
 */
function unfilterRow(row, scanline, pixels, y, stride, bytesPerPixel, filterType) {
	const prevRow = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);

	if (filterType === 0) {
		row.set(scanline);
		return;
	}

	for (let i = 0; i < stride; i += 1) {
		const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
		const up = prevRow ? prevRow[i] : 0;
		const upLeft = prevRow && i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0;

		if (filterType === 1) {
			row[i] = (scanline[i] + left) & 0xff;
		} else if (filterType === 2) {
			row[i] = (scanline[i] + up) & 0xff;
		} else if (filterType === 3) {
			row[i] = (scanline[i] + Math.floor((left + up) / 2)) & 0xff;
		} else if (filterType === 4) {
			row[i] = (scanline[i] + paethPredictor(left, up, upLeft)) & 0xff;
		} else {
			throw new Error(`Unsupported PNG filter type: ${filterType}`);
		}
	}
}

/**
 * Renders a target icon variant.
 *
 * @param {{ width: number, height: number, pixels: Uint8Array }} source Decoded source image.
 * @param {{ size: number, inset: number, background: number[] | null }} variant Render instruction.
 * @param {{ overlayGlyph: string | null }} target Target icon group.
 * @returns {Uint8Array} Rendered RGBA pixel buffer for the target icon.
 */
function renderVariant(source, variant, target) {
	const size = variant.size;
	const pixels = new Uint8Array(size * size * 4);

	if (variant.background) {
		fillBuffer(pixels, variant.background);
	}

	const insetPx = Math.round(size * variant.inset);
	const targetWidth = Math.max(size - insetPx * 2, 1);
	const targetHeight = Math.max(size - insetPx * 2, 1);

	for (let y = 0; y < targetHeight; y += 1) {
		const srcY = mapCoordinate(y, targetHeight, source.height);
		for (let x = 0; x < targetWidth; x += 1) {
			const srcX = mapCoordinate(x, targetWidth, source.width);
			const srcOffset = (srcY * source.width + srcX) * 4;
			const dstOffset = ((y + insetPx) * size + (x + insetPx)) * 4;
			blendPixel(pixels, dstOffset, source.pixels, srcOffset);
		}
	}

	if (target.overlayGlyph) {
		drawOverlayGlyph(pixels, size, target.overlayGlyph);
	}

	return pixels;
}

/**
 * Encodes RGBA pixels into a PNG file.
 *
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @param {Uint8Array} pixels RGBA pixel buffer.
 * @returns {Buffer} Encoded PNG file content.
 */
function encodePng(width, height, pixels) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	let rawOffset = 0;

	for (let y = 0; y < height; y += 1) {
		raw[rawOffset] = 0;
		rawOffset += 1;
		const srcOffset = y * stride;
		pixels.subarray(srcOffset, srcOffset + stride).forEach((value, index) => {
			raw[rawOffset + index] = value;
		});
		rawOffset += stride;
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const idat = zlib.deflateSync(raw);
	return Buffer.concat([
		PNG_SIGNATURE,
		createChunk('IHDR', ihdr),
		createChunk('IDAT', idat),
		createChunk('IEND', Buffer.alloc(0)),
	]);
}

/**
 * Creates a PNG chunk.
 *
 * @param {string} type Chunk type.
 * @param {Buffer} data Chunk payload.
 * @returns {Buffer} Complete PNG chunk including length and CRC.
 */
function createChunk(type, data) {
	const typeBuffer = Buffer.from(type, 'ascii');
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0, 0);
	return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Blends one source pixel over the destination pixel.
 *
 * @param {Uint8Array} destination Destination pixel buffer.
 * @param {number} destinationOffset Pixel offset in destination.
 * @param {Uint8Array} source Source pixel buffer.
 * @param {number} sourceOffset Pixel offset in source.
 * @returns {void}
 */
function blendPixel(destination, destinationOffset, source, sourceOffset) {
	const srcAlpha = source[sourceOffset + 3] / 255;
	if (srcAlpha <= 0) {
		return;
	}

	const dstAlpha = destination[destinationOffset + 3] / 255;
	const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);

	for (let i = 0; i < 3; i += 1) {
		const srcValue = source[sourceOffset + i];
		const dstValue = destination[destinationOffset + i];
		const outValue = (srcValue * srcAlpha + dstValue * dstAlpha * (1 - srcAlpha)) / outAlpha;
		destination[destinationOffset + i] = Math.round(outValue);
	}

	destination[destinationOffset + 3] = Math.round(outAlpha * 255);
}

/**
 * Maps a target coordinate to the nearest source coordinate.
 *
 * @param {number} index Target coordinate.
 * @param {number} targetLength Target axis length.
 * @param {number} sourceLength Source axis length.
 * @returns {number} Nearest-neighbor source coordinate.
 */
function mapCoordinate(index, targetLength, sourceLength) {
	const ratio = sourceLength / targetLength;
	return Math.min(sourceLength - 1, Math.floor((index + 0.5) * ratio));
}

/**
 * Fills a pixel buffer with a solid RGBA color.
 *
 * @param {Uint8Array} buffer Pixel buffer.
 * @param {number[]} color RGBA color array.
 * @returns {void}
 */
function fillBuffer(buffer, color) {
	for (let i = 0; i < buffer.length; i += 4) {
		buffer[i] = color[0];
		buffer[i + 1] = color[1];
		buffer[i + 2] = color[2];
		buffer[i + 3] = color[3];
	}
}

/**
 * Draws a simple identifying glyph on top of the icon.
 *
 * @param {Uint8Array} pixels RGBA pixel buffer.
 * @param {number} size Square icon size.
 * @param {string} glyph Glyph identifier.
 * @returns {void}
 */
function drawOverlayGlyph(pixels, size, glyph) {
	const pattern = GLYPHS[glyph];
	if (!pattern) {
		return;
	}

	const scale = Math.max(4, Math.floor(size / 24));
	const glyphWidth = pattern[0].length * scale;
	const glyphHeight = pattern.length * scale;
	const margin = Math.max(6, Math.floor(size / 14));
	const x = size - glyphWidth - margin;
	const y = size - glyphHeight - margin;
	const shadowOffset = Math.max(2, Math.floor(scale / 3));

	drawGlyphBitmap(pixels, size, pattern, x + shadowOffset, y + shadowOffset, scale, [0, 0, 0, 180]);
	drawGlyphBitmap(pixels, size, pattern, x, y, scale, [255, 255, 255, 255]);
}

/**
 * Draws a bitmap glyph into the pixel buffer.
 *
 * @param {Uint8Array} pixels RGBA pixel buffer.
 * @param {number} size Square icon size.
 * @param {string[]} pattern Glyph bitmap pattern.
 * @param {number} x Left position.
 * @param {number} y Top position.
 * @param {number} scale Pixel scale factor.
 * @param {number[]} color RGBA color array.
 * @returns {void}
 */
function drawGlyphBitmap(pixels, size, pattern, x, y, scale, color) {
	for (let row = 0; row < pattern.length; row += 1) {
		for (let col = 0; col < pattern[row].length; col += 1) {
			if (pattern[row][col] !== '1') {
				continue;
			}
			for (let dy = 0; dy < scale; dy += 1) {
				for (let dx = 0; dx < scale; dx += 1) {
					const px = x + col * scale + dx;
					const py = y + row * scale + dy;
					if (px < 0 || py < 0 || px >= size || py >= size) {
						continue;
					}
					const offset = (py * size + px) * 4;
					blendColor(pixels, offset, color);
				}
			}
		}
	}
}

/**
 * Blends a solid RGBA color over the destination pixel.
 *
 * @param {Uint8Array} destination Destination pixel buffer.
 * @param {number} destinationOffset Pixel offset in destination.
 * @param {number[]} color RGBA color array.
 * @returns {void}
 */
function blendColor(destination, destinationOffset, color) {
	const alphaSource = color[3] / 255;
	const alphaDestination = destination[destinationOffset + 3] / 255;
	const alphaOut = alphaSource + alphaDestination * (1 - alphaSource);

	for (let channel = 0; channel < 3; channel += 1) {
		const sourceValue = color[channel];
		const destinationValue = destination[destinationOffset + channel];
		const outValue =
			(sourceValue * alphaSource + destinationValue * alphaDestination * (1 - alphaSource)) / alphaOut;
		destination[destinationOffset + channel] = Math.round(outValue);
	}

	destination[destinationOffset + 3] = Math.round(alphaOut * 255);
}

/**
 * Builds the CRC32 lookup table once.
 *
 * @returns {Uint32Array} Precomputed CRC32 lookup table.
 */
function createCrcTable() {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let value = n;
		for (let k = 0; k < 8; k += 1) {
			value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[n] = value >>> 0;
	}
	return table;
}

/**
 * Calculates a PNG CRC32.
 *
 * @param {Buffer} buffer Chunk type + payload buffer.
 * @returns {number} Unsigned CRC32 value.
 */
function crc32(buffer) {
	let value = 0xffffffff;
	for (let i = 0; i < buffer.length; i += 1) {
		value = CRC_TABLE[(value ^ buffer[i]) & 0xff] ^ (value >>> 8);
	}
	return (value ^ 0xffffffff) >>> 0;
}

/**
 * Calculates the Paeth predictor.
 *
 * @param {number} left Left byte.
 * @param {number} up Upper byte.
 * @param {number} upLeft Upper-left byte.
 * @returns {number} Predicted byte value for PNG Paeth filtering.
 */
function paethPredictor(left, up, upLeft) {
	const p = left + up - upLeft;
	const pa = Math.abs(p - left);
	const pb = Math.abs(p - up);
	const pc = Math.abs(p - upLeft);

	if (pa <= pb && pa <= pc) {
		return left;
	}
	if (pb <= pc) {
		return up;
	}
	return upLeft;
}

const GLYPHS = {
	p: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
};

main();
