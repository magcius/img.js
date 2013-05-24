(function(exports) {

    function makeWorkerFromFunction(func) {
        var blob = new Blob([func.toString(), func.name + '(this);'], { type: 'text/javascript' });
        var url = window.URL.createObjectURL(blob);
        var w = new Worker(url);
        window.URL.revokeObjectURL(url);
        return w;
    }

    function gifWorker(global) {
        function makeStream(buffer) {
            var stream = new DataView(buffer);
            stream.length = buffer.byteLength;
            stream.pos = 0;
            return stream;
        }

        function readByte(stream) {
            return stream.getUint8(stream.pos++);
        }

        function readWord(stream) {
            return stream.getUint16((stream.pos += 2) - 2, true);
        }

        function collect(stream, f, length) {
            var B = [];
            for (var i = 0; i < length; i++)
                B.push(f(stream, i));
            return B;
        }

        function readString(stream, length) {
            var B = collect(stream, readByte, length);
            return B.map(function(c) {
                return String.fromCharCode(c);
            }).join('');
        }

        function parseColorTable(stream, flags) {
            function parseColor(stream) {
                var color = {};
                color.r = readByte(stream);
                color.g = readByte(stream);
                color.b = readByte(stream);
                return color;
            }

            if (flags & 0x80 != 0) {
                var sizeField = flags & 0x07;
                var count = 1 << (sizeField + 1);
                return collect(stream, parseColor, count);
            } else {
                return null;
            }
        }

        function makeBitstream(readByte) {
            // A bitstream is something that takes a bytestream and
            // tries to read the individual bits in it. The GIF format
            // tries to read the rightmost (least significant) bit
            // first, and tries to read the code in reverse order,
            // which is quite annoying. With two bytes and three code
            // of size 5, the packing looks like:
            //
            // byte 0 : bbbaaaaa
            // byte 1 : cccccbbb
            //
            // Note that the bits are in reverse order, with the
            // most significant bit being at the right-hand side.
            // This means that it isn't just a simple mask and shift,
            // but reuqires

            // Contains the most recently read byte from the stream.
            // This always contains the whole byte and should always
            // be masked against a mask gained from the bit position.
            var currentByte;

            // Contains the bit position of the current byte, with
            // "0" denoting the rightmost one, as GIF reads right to
            // left.
            // Force an initial read by making the code think we're
            // at the end of the current byte.
            var bitPosition = 8;

            // This takes a byte and a bit position and "plucks" the
            // bit from it. That is, if we have byte 0b10101010, you
            // can "pluck" bit position 3 to get a 1 back.
            // This should always return a 0 or 1.
            function pluck(byte, position) {
                return (byte >> position) & 1;
            }

            function read(nBits) {
                // n is our eventual out value.
                var n = 0;

                // pos counts the output position bit, with 0 denoting
                // the rightmost value. Putting a bit into "n" just
                // means taking the bit and left-shifting it by "pos",
                // which fills the byte up right-to-left.
                var pos = 0;
                while (nBits > 0) {
                    // If we've reached the end of this byte, read
                    // a new one.
                    if (bitPosition == 8) {
                        currentByte = readByte();
                        bitPosition = 0;
                    }

                    var bitsLeft = 8 - bitPosition;

                    // This denotes the number of bits to "install" in
                    // n in one iteration, that is, without reading
                    // another byte.
                    var length = Math.min(bitsLeft, nBits);

                    for (var i = 0; i < length; i++) {
                        // Pluck a bit from our buffered byte and then
                        // "install" it in n by left-shifting as above.
                        var bit = pluck(currentByte, bitPosition);
                        n |= bit << pos;

                        pos++;
                        bitPosition++;
                    }

                    nBits -= length;
                }

                return n;
            }

            return read;
        }


        function testBitstream() {
            var arr = new Uint8Array(3);
            arr[0] = parseInt("00110011", 2);
            arr[1] = parseInt("10101010", 2);
            arr[2] = parseInt("11110000", 2);

            var stream = makeStream(arr.buffer);
            var readBits = makeBitstream(stream);

            console.log(readBits(11).toString(2));
        }

        function parseLzw(output, readByte, minCodeSize) {
            // The dictionary maps code words to byte sequences and
            // gets updated as time goes on. It might be able to
            // make this dictionary a bit smarter by making it a
            // Uint8Array instead of an array, but oh well.
            var dictionary;

            // The code size determines how long each code will be,
            // in bits. The minimum code size, given to us by the
            // image block, contains the number of initial entries
            // in the dictionary.
            var codeSize;

            // These are always based off of the minimum code size
            // and never change as the code size is updated.
            // Specified in APPENDIX F of the spec.
            var clearCode = 1 << minCodeSize;
            var eoiCode = clearCode + 1;

            function clearState() {
                // Reset the code size to the first non-initial code.
                last = null;
                codeSize = minCodeSize + 1;
                dictionary = [];
            }

            function initDictionary() {
                var numInitialCodes = 1 << minCodeSize;
                for (var i = 0; i < numInitialCodes; i++)
                    dictionary[i] = [i];

                // These are unused, but are here to pad out the length
                // of the dictionary, otherwise the pushes would insert
                // values at the wrong index.
                dictionary[clearCode] = null;
                dictionary[eoiCode] = null;
            }

            // The dictionary isn't initialized by default.
            clearState();

            // The offset in the output array of pixels.
            var offs = 0;

            function out(entry) {
                var i = 0;
                while (i < entry.length)
                    output[offs++] = entry[i++];
            }

            var last;
            var readCode = makeBitstream(readByte);

            var x = 0;
            while (true) {
                var code = readCode(codeSize);

                if (code === clearCode) {
                    // The encoder wants us to clear our dictionaries
                    // to be re-filled, probably because the current
                    // compression isn't working very well and it wants
                    // to try again with shorter codes.
                    clearState();
                    initDictionary();
                    continue;
                }

                if (code == eoiCode || code == null) {
                    // End of image.
                    break;
                }

                var entry;
                if (code < dictionary.length) {
                    // The code is in the dictionary.
                    entry = dictionary[code];
                } else if (code == dictionary.length) {
                    // This is the next code the encoder made, which
                    // means it was generated as part of the last
                    // sequence. This means that the entry must be
                    // the last sequence plus the first integer
                    // of the last sequence.
                    entry = last.concat(last[0]);
                } else {
                    // Greater than the next code in the dictionary.
                    // We have no way of knowing what the entry is,
                    // which means it's invalid.
                    throw new Error("Invalid LZW data");
                }

                out(entry);
                if (last !== null)
                    dictionary.push(last.concat(entry[0]));
                last = entry;

                // If we've reached the last code possible for a
                // certain code length, that means we need to bump
                // the code size.
                if (dictionary.length === (1 << codeSize))
                    codeSize++;
            }
        }

        function parseImageBlock(stream, globalColorTable) {
            var command = { type: "draw" };
            command.left = readWord(stream);
            command.top = readWord(stream);
            command.width = readWord(stream);
            command.height = readWord(stream);
            var flags = readByte(stream);
            command.colorTable = parseColorTable(stream, flags) || globalColorTable;

            var minCodeSize = readByte(stream);
            var pos, size;
            function readByteFromSubBlocks() {
                // The GIF specification encodes data into these
                // tiny things called subblocks. I don't see why
                // they did this, as LZW already has an end-code,
                // but oh well, we have to support it.

                // This traps the initial condition as well, as
                // both are undefined :)
                if (pos === size) {
                    size = readByte(stream);
                    pos = 0;
                }

                pos++;
                return readByte(stream);
            }

            // This contains a large array of indexes into the color table.
            command.indices = new Uint8Array(command.width * command.height);
            parseLzw(command.indices, readByteFromSubBlocks, minCodeSize);

            return command;
        }

        function parseGif(stream) {
            var gif = {};

            var header = readString(stream, 3);
            var version = readString(stream, 3);
            gif.width = readWord(stream);
            gif.height = readWord(stream);
            var flags = readByte(stream);
            var bgColor = readByte(stream); // unused
            var pixelAspectRatio = readByte(stream);
            var globalColorTable = parseColorTable(stream, flags);

            gif.commands = [];

            var go = true;
            while (go) {
                var blockType = readByte(stream);
                switch (blockType) {
                    case 0x3B: // Image trailer
                        go = false;
                        break;
                    case 0x2C: // Image block
                        gif.commands.push(parseImageBlock(stream, globalColorTable));
                        break;
                    default: // Unknown block
                        break;
                }
            }

            return gif;
        }

        function fetch(path) {
            var request = new XMLHttpRequest();
            request.open("GET", path, true);
            request.responseType = "arraybuffer";
            request.send();
            return request;
        }

        global.onmessage = function(event) {
            var req = fetch(event.data.filename);
            req.onload = function() {
                var stream = makeStream(req.response);
                var gif = parseGif(stream);
                global.postMessage({ gif: gif });
            };
        };
    }

    function loadGif(filename, callback) {
        var w = makeWorkerFromFunction(gifWorker);
        w.addEventListener('message', function(event) {
            callback(event.data.gif);
        });
        w.postMessage({ filename: filename });
    }

    exports.loadGif = loadGif;
})(window);
