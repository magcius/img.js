(function(exports) {

    function makeWorkerFromFunction(func) {
        var blob = new Blob([func.toString(), func.name + '(this);'], { type: 'text/javascript' });
        var url = window.URL.createObjectURL(blob);
        var w = new Worker(url);
        window.URL.revokeObjectURL(url);
        return w;
    }

    // GIF parser -- a web worker to parse the GIF structure
    function gifWorker(global) {
        function log() {
            global.postMessage({ log: [].slice.call(arguments) });
        }

        function Stream() {
            this._chunks = [];
            this._pos = 0;
            this._chunkPos = 0;
            this._currentChunk = null;
            this._savedPos = [];
        }
        Stream.prototype = {
            get pos() {
                return this._pos;
            },

            set pos(value) {
                this._pos = value;
                this._updateChunk();
            },

            _findChunkForPos: function(pos) {
                for (var i = 0; i < this._chunks.length; i++) {
                    var chunk = this._chunks[i];
                    if (pos < chunk.end)
                        return chunk;
                }
                return null;
            },

            _updateChunk: function() {
                this._currentChunk = this._findChunkForPos(this._pos);
                if (this._currentChunk)
                    this._chunkPos = this._pos - this._currentChunk.start;
            },

            addChunk: function(buffer) {
                var chunk = new DataView(buffer);
                if (this._chunks.length)
                    chunk.start = this._chunks[this._chunks.length - 1].end;
                else
                    chunk.start = 0;
                chunk.end = chunk.start + chunk.buffer.byteLength;
                this._chunks.push(chunk);
                this._updateChunk();
            },

            save: function() {
                this._savedPos.push(this.pos);
            },

            restore: function() {
                this.pos = this._savedPos.pop();
            },

            readByte: function() {
                var x = this._currentChunk.getUint8(this._chunkPos);
                this.pos++;
                return x;
            },

            readWord: function() {
                var x;
                try {
                    x = this._currentChunk.getUint16(this._chunkPos, true);
                    this.pos += 2;
                } catch(e) {
                    // Slow path -- word falls across chunk boundaries
                    x = this._currentChunk.getUint8(this._chunkPos);
                    this.pos++;
                    x |= this._currentChunk.getUint8(this._chunkPos) << 8;
                    this.pos++;
                }
                return x;
            },
        };

        function readByte(stream) {
            return stream.readByte();
        }

        function readWord(stream) {
            return stream.readWord();
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

        function seekUntil0(stream) {
            // Seek until block terminator
            while (true) {
                if (readByte(stream) == 0)
                    break;
            }
        }

        function parseColorTable(stream, flags) {
            function parseColor(stream) {
                var color = {};
                color.r = readByte(stream);
                color.g = readByte(stream);
                color.b = readByte(stream);
                return color;
            }

            if ((flags & 0x80) != 0) {
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

        var MAX_CODE_SIZE = 12;
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
                if (dictionary.length === (1 << codeSize) && codeSize < MAX_CODE_SIZE)
                    codeSize++;
            }
        }

        var disposals = {};
        // GIF spec says "does nothing", but all GIF decoders
        // just assume it means no dispose.
        disposals[0x00] = "composite";
        disposals[0x01] = "composite";
        disposals[0x02] = "clearArea";
        disposals[0x03] = "remove";
        // Early GIF specs said "bit 3" instead of "third bit"
        disposals[0x04] = "remove";

        function parseGraphicControlExtension(command, stream) {
            // size, unused
            readByte(stream);

            var flags = readByte(stream);
            var delayInHundredths = readWord(stream);
            var disposal = (flags >> 2) & 0x07;

            command.disposal = disposals[disposal];

            // Convert into milliseconds for easy setTimeout usage
            command.duration = delayInHundredths * 10;

            var transparentPixel = readByte(stream);
            if (flags & 0x01)
                command.transparentPixel = transparentPixel;
            else
                command.transparentPixel = null;

            // block terminator
            stream.pos++;
        }

        function parseCommentExtension(command, stream) {
            command.type = "comment";
            command.data = "";

            while (true) {
                var size = readByte(stream);
                if (size == 0)
                    break;
                command.data += readString(size);
            }
        }

        function parsePlainTextExtension(command, stream) {
            command.type = "text";

            // size, unused
            readByte(stream);

            command.left = readWord(stream);
            command.top = readWord(stream);
            command.width = readWord(stream);
            command.height = readWord(stream);
            command.cellWidth = readByte(stream);
            command.cellHeight = readByte(stream);

            command.fgColor = readByte(stream);
            command.bgColor = readByte(stream);
            command.data = "";

            while (true) {
                var size = readByte(stream);
                if (size == 0)
                    break;
                command.data += readString(stream, size);
            }

            command.flush();
        }

        function parseNetscapeExtension(command, stream) {
            // auth code, unused
            stream.pos += 3;

            // unknown
            stream.pos += 2;

            var loopCount = readWord(stream);
            global.postMessage({
                type: "looping",
                loopCount: loopCount,
            });

            // block terminator
            stream.pos++;
        }

        var appExtensions = {};
        appExtensions["NETSCAPE"] = parseNetscapeExtension;

        function parseApplicationExtension(command, stream) {
            // size, unused
            readByte(stream);

            var identifier = readString(stream, 8);

            var func = appExtensions[identifier];
            if (func)
                func(command, stream);
            else
                seekUntil0(stream);
        }

        var extensions = {};
        extensions[0xF9] = parseGraphicControlExtension;
        extensions[0x01] = parsePlainTextExtension;
        extensions[0xFE] = parseCommentExtension;
        extensions[0xFF] = parseApplicationExtension;

        function parseExtension(command, stream) {
            var extensionType = readByte(stream);

            var func = extensions[extensionType];
            if (func)
                func(command, stream);
            else
                seekUntil0(stream);
        }

        function parseImageBlock(command, stream) {
            command.type = "draw";
            command.left = readWord(stream);
            command.top = readWord(stream);
            command.width = readWord(stream);
            command.height = readWord(stream);
            var flags = readByte(stream);
            command.lct = parseColorTable(stream, flags);

            var minCodeSize = readByte(stream);
            var pos, size;
            function readByteFromSubBlocks() {
                // The GIF specification encodes data into these
                // tiny things called subblocks. I don't see why
                // they did this, as LZW already has an end-code,
                // but oh well, we have to support it.

                // This traps the initial condition as well, as
                // both are undefined
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

            // LZW might have an EOF code before we read the entire
            // set of sub blocks. Look for a block terminator.
            if (pos !== 0)
                seekUntil0(stream);

            command.flush();
        }

        var blocks = {};
        blocks[0x21] = parseExtension;
        blocks[0x2C] = parseImageBlock;

        function parseGif(stream) {
            var header = readString(stream, 3);
            var version = readString(stream, 3);
            var width = readWord(stream);
            var height = readWord(stream);

            global.postMessage({
                type: "dimensions",
                width: width,
                height: height,
            });

            var flags = readByte(stream);
            var bgColor = readByte(stream); // unused
            var pixelAspectRatio = readByte(stream);
            var gct = parseColorTable(stream, flags);

            global.postMessage({
                type: "gct",
                gct: gct,
            });

            var command;
            function resetCommand() {
                command = { flush: flush };
            }

            function flush() {
                delete command.flush;
                global.postMessage({
                    type: "command",
                    command: command,
                });
                resetCommand();
            }

            resetCommand();
            while (true) {
                var blockType = readByte(stream);
                if (blockType == 0x3B)
                    break;

                var func = blocks[blockType];
                if (func)
                    func(command, stream);
            }

            global.postMessage({
                type: "finished",
            });
        }

        function makeChunkFromText(text) {
            var arr = new Uint8Array(text.length);
            for (var i = 0; i < text.length; i++)
                arr[i] = text.charCodeAt(i) & 0xFF;
            return arr.buffer;
        }

        function fetch(stream, path, callback) {
            var req = new XMLHttpRequest();
            req.open("GET", path, true);
            req.overrideMimeType('text/plain; charset=x-user-defined');
            req.send();
            req.onload = function() {
                var chunk = makeChunkFromText(req.responseText);
                stream.addChunk(chunk);
                callback();
            };
            return req;
        }

        global.onmessage = function(event) {
            var stream = new Stream();
            var req = fetch(stream, event.data.filename, function() {
                parseGif(stream);
            });
        };
    }

    function loadGif(filename, callback) {
        var w = makeWorkerFromFunction(gifWorker);
        w.addEventListener('message', function(event) {
            if (event.data.log)
                console.log("worker log", event.data.log);
            else
                callback(event.data);
        });
        w.postMessage({ filename: filename });
    }

    // GIF Runner -- uses <canvas> and DOM tricks to take the above
    // commands and paint them.
    function runGif(filename) {
        var container = document.createElement("gif-container");
        container.style.position = "relative";

        var width, height;
        var gct;

        // Images from composite commands are added to the
        // temporary canvas first, and at the start of a new
        // composite command, they're "disposed" of into the
        // composite canvas if necessary.
        var compositeCanvas, temporaryCanvas;

        var commands = [];

        // By default, loop forever.
        var maxLoops = 0;

        var finished = false;
        var waitingForCommand = true;

        function makeCanvas() {
            var canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            canvas.style.position = "absolute";
            canvas.style.left = "0px";
            canvas.style.top = "0px";
            return canvas;
        }

        function makeCanvases() {
            compositeCanvas = makeCanvas();
            temporaryCanvas = makeCanvas();

            container.appendChild(compositeCanvas);
            container.appendChild(temporaryCanvas);
        }

        function disposeImage(tempCanvas, compCanvas, command) {
            var tempCtx = tempCanvas.getContext('2d');
            var compCtx = compCanvas.getContext('2d');

            compCtx.save();
            switch (command.disposal) {
                case "composite":
                // In a composite command, the contents of the
                // temporary composited onto the underlying canvas.
                compCtx.drawImage(tempCanvas, 0, 0);
                break;
                case "restore":
                // The specification says "restore to bgColor",
                // but no GIF decoder cares about the bgColor.
                // Restore to the default color, transparent black.
                compCtx.fillStyle = 'rgba(0, 0, 0, 0)';
                compCtx.fillRect(command.left, command.top, command.width, command.height);
                break;
                case "remove":
                // In the case of remove, we don't composite
                // anything to the composite canvas, so simply
                // do nothing. The temp canvas will be cleared
                // below.
                break;
            }
            compCtx.restore();

            // Clear the temp canvas.
            tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
        }

        function drawCommand(canvas, command) {
            var ctx = canvas.getContext('2d');
            var imgData = ctx.getImageData(command.left, command.top, command.width, command.height);
            var i, o = 0, n = command.indices.length;
            var data = imgData.data;
            var colorTable = command.lct || gct;

            for (i = 0; i < n; i++) {
                var index = command.indices[i];
                if (index == command.transparentPixel) {
                    data[o++] = 0;
                    data[o++] = 0;
                    data[o++] = 0;
                    data[o++] = 0;
                } else {
                    data[o++] = colorTable[index].r;
                    data[o++] = colorTable[index].g;
                    data[o++] = colorTable[index].b;
                    data[o++] = 255;
                }
            }
            ctx.putImageData(imgData, command.left, command.top);
        }

        function textCommand(canvas, command) {
            var ctx = canvas.getContext('2d');

            function setFont() {
                var size = command.cellHeight;
                ctx.font = size + "px \"Courier New\"";
            }

            function styleFromColor(idx) {
                var color = gct[idx];
                return 'rgb(' + color.r + ', ' + color.g + ', ' + color.b + ')';
            }

            function drawChar(char, cellX, cellY) {
                var x = command.left + command.cellWidth * cellX;
                var y = command.top + command.cellHeight * (cellY + 0.8);

                var code = char.charCodeAt(0);
                ctx.fillText(char, x, y);
            }

            ctx.save();
            ctx.fillStyle = styleFromColor(command.bgColor);
            ctx.fillRect(command.left, command.top, command.width, command.height);
            ctx.restore();

            ctx.save();
            setFont();
            ctx.fillStyle = styleFromColor(command.fgColor);
            var cellX = 0, cellY = 0;
            var charsPerLine = (command.width / command.cellWidth) | 0;

            command.data.split('').forEach(function(char) {
                drawChar(char, cellX, cellY);

                cellX++;
                if (cellX >= charsPerLine) {
                    cellY++;
                    cellX = 0;
                }
            });
            ctx.restore();
        }

        var commandTypes = {
            "draw": drawCommand,
            "text": textCommand,
        };

        // default duration is 1/10th of a second
        var DEFAULT_DURATION = (1 / 10) * 1000;
        var MIN_DURATION = 20;

        var command;
        var idx = 0;
        var loopCount = 0;

        function runCommand() {
            command = commands[idx];
            var func = commandTypes[command.type];
            if (func) {
                // Commands are always first drawn into the temp
                // canvas. The disposal at the start of the next
                // next command will put things into the
                // composite canvas if wanted.
                func(temporaryCanvas, command);
            } else {
                console.log("Unknown command " + command.type);
            }

            scheduleNextCommand();
        }

        function nextCommand() {
            if (idx+1 >= commands.length) {
                if (finished) {
                    loopCount++;

                    // If we've reached the maximum loop, pause at the
                    // last frame.
                    if (maxLoops != 0 && loopCount > maxLoops)
                        return;

                    idx = 0;
                } else {
                    // Pause until we receive the next command.
                    waitingForCommand = true;
                }
            } else {
                idx++;
            }

            if (command)
                disposeImage(temporaryCanvas, compositeCanvas, command);
            runCommand();
        }

        function scheduleNextCommand() {
            var duration = command.duration;
            if (duration === undefined || duration < MIN_DURATION)
                duration = DEFAULT_DURATION;

            setTimeout(nextCommand, duration);
        }

        function maybeUnpause() {
            if (!waitingForCommand)
                return;

            nextCommand();
            waitingForCommand = false;
        }

        function onMessage_dimensions(message) {
            width = message.width;
            height = message.height;
            makeCanvases();
        }

        function onMessage_gct(message) {
            gct = message.gct;
        }

        function onMessage_looping(message) {
            maxLoops = message.loopCount;
        }

        function onMessage_command(message) {
            commands.push(message.command);
            maybeUnpause();
        }

        function onMessage_finished(message) {
            finished = true;
            maybeUnpause();
        }

        var messages = {};
        messages["dimensions"] = onMessage_dimensions;
        messages["gct"] = onMessage_gct;
        messages["looping"] = onMessage_looping;
        messages["command"] = onMessage_command;
        messages["finished"] = onMessage_finished;

        function onMessage(message) {
            var func = messages[message.type];
            func(message);
        }

        loadGif(filename, onMessage);

        return container;
    }

    exports.runGif = runGif;

})(window);
