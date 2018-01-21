const { Transform } = require('stream');

const OPUS_HEAD = Buffer.from([...'OpusHead'].map(x => x.charCodeAt(0)));

/**
 * Demuxes a Webm stream (containing Opus audio) to output an Opus stream.
 * @extends {TransformStream}
 */
class WebmOpusDemuxer extends Transform {
  /**
   * Creates a new WebmOpus demuxer.
   * @param {Object} [options] options that you would pass to a regular Transform stream.
   */
  constructor(options = {}) {
    super(Object.assign({ readableObjectMode: true }, options));
    this._remainder = null;
    this._length = 0;
    this._count = 0;
    this._skipUntil = null;
    this._track = null;
    this._incompleteTrack = {};
    this._ebmlFound = false;
  }

  _transform(chunk, encoding, done) {
    this._length += chunk.length;
    if (this._remainder) {
      chunk = Buffer.concat([this._remainder, chunk]);
      this._remainder = null;
    }
    let offset = 0;
    if (this._skipUntil && this._length > this._skipUntil) {
      offset = this._skipUntil - this._count;
      this._skipUntil = null;
    } else if (this._skipUntil) {
      this._count += chunk.length;
      return done();
    }
    let result;
    while (result !== TOO_SHORT) {
      result = this._readTag(chunk, offset);
      if (result === TOO_SHORT) break;
      if (result._skipUntil) {
        this._skipUntil = result._skipUntil;
        break;
      }
      if (result.offset) offset = result.offset;
      else break;
    }
    this._count += offset;
    this._remainder = chunk.slice(offset);
    return done();
  }

  /**
   * Reads an EBML ID from a buffer.
   * @private
   * @param {Buffer} chunk the buffer to read from.
   * @param {number} offset the offset in the buffer.
   * @returns {Object|Symbol} contains an `id` property (buffer) and the new `offset` (number).
   * Returns the TOO_SHORT symbol if the data wasn't big enough to facilitate the request.
   */
  _readEBMLId(chunk, offset) {
    const idLength = vintLength(chunk, offset);
    if (idLength === TOO_SHORT) return TOO_SHORT;
    return {
      id: chunk.slice(offset, offset + idLength),
      offset: offset + idLength,
    };
  }

  /**
   * Reads a size variable-integer to calculate the length of the data of a tag.
   * @private
   * @param {Buffer} chunk the buffer to read from.
   * @param {number} offset the offset in the buffer.
   * @returns {Object|Symbol} contains property `offset` (number), `dataLength` (number) and `sizeLength` (number).
   * Returns the TOO_SHORT symbol if the data wasn't big enough to facilitate the request.
   */
  _readTagDataSize(chunk, offset) {
    const sizeLength = vintLength(chunk, offset);
    if (sizeLength === TOO_SHORT) return TOO_SHORT;
    const dataLength = expandVint(chunk, offset, offset + sizeLength);
    return { offset: offset + sizeLength, dataLength, sizeLength };
  }

  /**
   * Takes a buffer and attempts to read and process a tag.
   * @private
   * @param {Buffer} chunk the buffer to read from.
   * @param {number} offset the offset in the buffer.
   * @returns {Object|Symbol} contains the new `offset` (number) and optionally the `_skipUntil` property,
   * indicating that the stream should ignore any data until a certain length is reached.
   * Returns the TOO_SHORT symbol if the data wasn't big enough to facilitate the request.
   */
  _readTag(chunk, offset) {
    const idData = this._readEBMLId(chunk, offset);
    if (idData === TOO_SHORT) return TOO_SHORT;
    const ebmlID = idData.id.toString('hex');
    if (!this._ebmlFound) {
      if (ebmlID === '1a45dfa3') this._ebmlFound = true;
      else throw Error('Did not find the EBML tag at the start of the stream');
    }
    offset = idData.offset;
    const sizeData = this._readTagDataSize(chunk, offset);
    if (sizeData === TOO_SHORT) return TOO_SHORT;
    const { dataLength } = sizeData;
    offset = sizeData.offset;
    // If this tag isn't useful, tell the stream to stop processing data until the tag ends
    if (typeof TAGS[ebmlID] === 'undefined') {
      if (chunk.length > offset + dataLength) {
        return { offset: offset + dataLength };
      }
      return { offset, _skipUntil: this._count + offset + dataLength };
    }

    const tagHasChildren = TAGS[ebmlID];
    if (tagHasChildren) {
      return { offset };
    }

    if (offset + dataLength > chunk.length) return TOO_SHORT;
    const data = chunk.slice(offset, offset + dataLength);
    if (!this._track) {
      if (ebmlID === 'ae') this._incompleteTrack = {};
      if (ebmlID === 'd7') this._incompleteTrack.number = data[0];
      if (ebmlID === '83') this._incompleteTrack.type = data[0];
      if (this._incompleteTrack.type === 2 && typeof this._incompleteTrack.number !== 'undefined') {
        this._track = this._incompleteTrack;
      }
    }
    if (ebmlID === '63a2') {
      if (!data.slice(0, 8).equals(OPUS_HEAD)) {
        throw Error('Audio codec is not Opus!');
      }
    } else if (ebmlID === 'a3') {
      if (!this._track) throw Error('No audio track in this webm!');
      if ((data[0] & 0xF) === this._track.number) {
        this.push(data.slice(4));
      }
    }
    return { offset: offset + dataLength };
  }
}

/**
 * A symbol that is returned by some functions that indicates the buffer it has been provided is not large enough
 * to facilitate a request.
 * @name WebmOpusDemuxer#TOO_SHORT
 * @type {Symbol}
 */
const TOO_SHORT = WebmOpusDemuxer.TOO_SHORT = Symbol('TOO_SHORT');

/**
 * A map that takes a value of an EBML ID in hex string form, with the value being a boolean that indicates whether
 * this tag has children.
 * @name WebmOpusDemuxer#TAGS
 * @type {Object}
 */
const TAGS = WebmOpusDemuxer.TAGS = { // value is true if the element has children
  '1a45dfa3': true, // EBML
  '18538067': true, // Segment
  '1f43b675': true, // Cluster
  '1654ae6b': true, // Tracks
  'ae': true, // TrackEntry
  'd7': false, // TrackNumber
  '83': false, // TrackType
  'a3': false, // SimpleBlock
  '63a2': false,
};

module.exports = WebmOpusDemuxer;

function vintLength(buffer, index) {
  let i = 0;
  for (; i < 8; i++) if ((1 << (7 - i)) & buffer[index]) break;
  i++;
  if (index + i > buffer.length) {
    return TOO_SHORT;
  }
  return i;
}

function expandVint(buffer, start, end) {
  const length = vintLength(buffer, start);
  if (end > buffer.length || length === TOO_SHORT) return TOO_SHORT;
  let mask = (1 << (8 - length)) - 1;
  let value = buffer[start] & mask;
  for (let i = start + 1; i < end; i++) {
    value = (value << 8) + buffer[i];
  }
  return value;
}
