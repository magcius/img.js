(function(exports) {
    "use strict";

    function makeStream(buffer) {
        var stream = new DataView(buffer);
        stream.length = buffer.byteLength;
        stream.pos = 0;
        return stream;
    }

    function eof(stream) {
        return stream.pos >= stream.length;
    }

    function readByte(stream) {
        return stream.getUint8(stream.pos++);
    }

    function readWord(stream) {
        return stream.getUint16((stream.pos += 2) - 2);
    }

    function collect(stream, f, length) {
        var B = [];
        for (var i = 0; i < length; i++)
            B.push(f(stream, i));
        return B;
    }

    function fetch(path) {
        var request = new XMLHttpRequest();
        request.open("GET", path, true);
        request.responseType = "arraybuffer";
        request.send();
        return request;
    }

    function parseDQT(stream, jpeg, length) {
        jpeg.quantizationTables = {};

        var end = stream.pos + length;
        while (stream.pos < end) {
            var info = readByte(stream);
            var precision = (info & 0xF0);
            var tableId = (info & 0x0F);

            var table;
            if (precision === 0)
                table = collect(stream, readByte, 64);
            else
                table = collect(stream, readWord, 64);

            jpeg.quantizationTables[tableId] = table;
        }
    }

    function parseSOF(stream, jpeg, length) {
        var precision = readByte(stream);
        if (precision !== 8)
            console.error("bad precision");

        jpeg.height = readWord(stream);
        jpeg.width = readWord(stream);

        // Round up to next multiple of 8
        jpeg.expandedWidth = (jpeg.width + 7) & ~7;
        jpeg.expandedHeight = (jpeg.height + 7) & ~7;

        var nComponents = readByte(stream);
        if (nComponents !== 1 && nComponents !== 3)
            throw new Error("Bad components");

        jpeg.components = {};

        function parseComponent(stream) {
            var id = readByte(stream);
            var samplingFactors = readByte(stream);
            var quantizationTableId = readByte(stream);

            var component = {};
            component.id = id;
            component.horzSample = samplingFactors >> 4;
            component.vertSample = (samplingFactors & 0x0F);
            component.quantizationTable = jpeg.quantizationTables[quantizationTableId];

            var width = jpeg.expandedWidth / component.horzSample;
            var height = jpeg.expandedHeight / component.vertSample;
            var size = width * height;
            component.plane = new Int8Array(size);

            jpeg.components[id] = component;
        }

        for (var i = 0; i < nComponents; i++)
            parseComponent(stream);
    }

    function parseHuffmanTable(stream) {
        var codeSizes = collect(stream, readByte, 16);

        function huffmanCodeString(code, codeSize) {
            function pad(S, n) {
                while (S.length < n)
                    S = "0" + S;
                return S;
            }

            return pad(code.toString(2), codeSize);
        }

        var table = {};
        var code = 0;
        codeSizes.forEach(function(nValues, i) {
            var codeSize = i + 1;

            var values = collect(stream, readByte, nValues);
            values.forEach(function(value) {
                table[huffmanCodeString(code, codeSize)] = value;
                code++;
            });

            code <<= 1;
        });

        return table;
    }

    function parseDHT(stream, jpeg, length) {
        var end = stream.pos + length;
        while (stream.pos < end) {
            var info = readByte(stream);
            var acTable = (info & 0xF0);
            var tableId = (info & 0x0F);

            var table = parseHuffmanTable(stream);
            if (acTable)
                jpeg.acHuffmanTables[tableId] = table;
            else
                jpeg.dcHuffmanTables[tableId] = table;
        }
    }

    function makeBitstream(stream) {
        var currentByte;
        var bitPosition = 8;

        function chompByte() {
            currentByte = readByte(stream);
            bitPosition = 0;

            // If we see `FF`, then the byte that needs to follow needs to be `00`.
            // If it isn't `00`, then we've hit an unexpected marker, meaning either
            // our fault, or an invalid JPEG file.
            // We need to ignore the following `00` and simply treat the `FF00`
            // sequence as if it was `FF`.
            if (currentByte == 0xFF) {
                var nextByte = readByte(stream);
                if (nextByte != 0x00)
                    throw new Error("Hit premature end of marker");
            }
        }

        function readBits(nBits) {
            // n is our eventual out value.
            var n = 0;

            var pos = 0;
            while (nBits > 0) {
                // If we've reached the end of this byte, read
                // a new one.
                if (bitPosition == 8)
                    chompByte();

                var bitsLeft = 8 - bitPosition;

                // This denotes the number of bits to "install" in
                // n in one iteration, that is, without reading
                // another byte.
                var length = Math.min(bitsLeft, nBits);
                var shift = bitsLeft - length;

                n <<= length;
                n |= (currentByte >> shift) & ((1 << length) - 1);

                nBits -= length;
                bitPosition += length;
            }

            return n;
        }

        return readBits;
    }

    function testBitstream() {
        var x = ["00110011", "10101010", "10110110", "10111010"];
        var arr = new Uint8Array(x.length);
        x.forEach(function(n, i) {
            arr[i] = parseInt(n, 2);
        });
        var s = x.join('');

        function pad(S, n) {
            while (S.length < n)
                S = "0" + S;
            return S;
        }

        function testLength(n) {
            var stream = makeStream(arr.buffer);
            var readBits = makeBitstream(stream);

            var b = '';
            while (b.length < s.length)
                b += pad(readBits(n).toString(2), n);

            if (b != s)
                console.error("Bad bitstream " + n);
        }

        testLength(8);
        testLength(4);
        testLength(2);
        testLength(1);
    }

    function readHuffmanBitstream(readBits, table) {
        var bits = "";

        while (true) {
            var bit = readBits(1);
            bits += bit;

            if (table[bits] !== undefined)
                return table[bits];

            if (bits.length > 16)
                throw new Error("Invalid huffman sequence");
        }
    }

    function decodeJPEGNumber(nBits, number) {
        // JPEG's packed numbers aren't regular two's complement numbers.
        // Instead, every number is identified by both a "category", and a
        // bit pattern. The category also defines the number of bits in the
        // bit pattern. The scheme can be explained with a simple table:
        //
        // Category | Bit Patterns                    | Values
        // 0        | --                              | 0
        // 1        | 0,1                             | -1,1
        // 2        | 00,01,10,11                     | -3,-2,2,3
        // 3        | 000,001,010,011,100,101,110,111 | -7,-6,-5,-4,4,5,6,7
        // ...
        //
        // There is probably a more efficient way to do this.

        var mid = 1 << (nBits - 1);
        var mask = (1 << nBits) - 1;
        if (number < mid)
            return -(~number & mask);
        else
            return number;
    }

    var DEZIGZAG = [
         0,  1,  8, 16,  9,  2,  3, 10,
        17, 24, 32, 25, 18, 11,  4,  5,
        12, 19, 26, 33, 40, 48, 41, 34,
        27, 20, 13,  6,  7, 14, 21, 28,
        35, 42, 49, 56, 57, 50, 43, 36,
        29, 22, 15, 23, 30, 37, 44, 51,
        58, 59, 52, 45, 38, 31, 39, 46,
    ];

    function readDCCoefficient(coeffs, state, readBits) {
        var nBits = readHuffmanBitstream(readBits, state.dcTable);
        var pattern = readBits(nBits);
        var number = decodeJPEGNumber(nBits, pattern);
        state.predictedDC += number;
        coeffs[0] = state.predictedDC; // * state.quantTable[0];
    }

    function readACCoefficients(coeffs, state, readBits) {
        var i = 0;

        function out(x) {
            var idx = ++i;
            coeffs[DEZIGZAG[idx]] = x * state.quantTable[idx];
        }

        // AC coefficients are run-length encoded.
        while (i < 64) {
            // packed is composed of (nZeroes, nBits) in each niblet.
            var packed = readHuffmanBitstream(readBits, state.acTable);

            // If we got (0,0), then this is a special marker, EOB,
            // or "End of Block". This means to fill the rest of the
            // block with zeroes. Note that if the last coefficient
            // isn't 0, we may not get this.
            if (packed == 0)
                return;

            var nZeroes, nBits;

            // If we got (15,0), then this is a special encoding
            // for 16 zeroes, not 15 zeroes.
            if (packed == (15 << 4)) {
                nZeroes = 16;
                nBits = 0;
            } else {
                nZeroes = packed >> 4;
                nBits = (packed & 0x0F);
            }

            i += nZeroes;

            if (nBits > 0) {
                var pattern = readBits(nBits);
                out(decodeJPEGNumber(nBits, pattern));
            }
        }
    }

    // See http://tauday.com/
    var TAU = Math.PI * 2;

    function idct(pixels, src) {
        function idct_1d(dest, coeffs, offset, step) {
            var N = 8;
            var n;

            // We start with all pixel values having the DC offset.
            for (n = 0; n < N; n++)
                dest[offset + n*step] = coeffs[0];

            // The rest are frequency coefficients; sum them up one
            // at a time.
            for (var k = 1; k < N; k++) {
                // Normalize the coefficient from 0 to 1.
                var coef = coeffs[offset + k*step] / 256.0;

                // DCT-II says that the basis functions we use are
                // cosines with increasing 1/4 frequencies.
                var frequency = TAU * (1/4) * k;

                for (n = 0; n < N; n++) {
                    var theta = (2*n+1) / N;
                    dest[offset + n*step] += coef * Math.cos(frequency * theta);
                }
            }
        }

        var tmp = new Array(64);

        // First do all the rows
        for (var i = 0; i < 8; i++)
            idct_1d(tmp, src, i*8, 1);

        // Now all the columns
        for (var i = 0; i < 8; i++)
            idct_1d(pixels, tmp, i, 8);
    }

    // Minimum Coded Unit. This includes all component planes.
    function readMCU(readBits, jpeg, mcuLayout, planeOffset) {
        mcuLayout.forEach(function(mcu) {
            var scanComponent = mcu.scanComponent;
            var plane = scanComponent.plane;
            var coeffs = new Int8Array(64);
            readDCCoefficient(coeffs, scanComponent, readBits);
            readACCoefficients(coeffs, scanComponent, readBits);

            var offset = plane.byteOffset + planeOffset + mcu.offset;
            var pixels = new Int8Array(plane.buffer, offset, 64);
            idct(pixels, coeffs);
        });
    }

    function parseSOS(stream, jpeg, length) {
        var nScanComponents = readByte(stream);
        function parseScanComponent(stream) {
            var scanComponent = {};

            var selector = readByte(stream);
            var component = jpeg.components[selector];
            scanComponent.quantTable = component.quantizationTable;
            scanComponent.plane = component.plane;

            var tableInfo = readByte(stream);
            var dcTableId = (tableInfo & 0xF0) >> 4;
            var acTableId = (tableInfo & 0x0F);

            scanComponent.dcTable = jpeg.dcHuffmanTables[dcTableId];
            scanComponent.acTable = jpeg.acHuffmanTables[acTableId];

            scanComponent.predictedDC = 0;

            return scanComponent;
        }
        var scanComponents = collect(stream, parseScanComponent, nScanComponents);

        // I don't think these are necessary at all. These three bytes are
        // marked as "spectral start", "spectral end", and "approximation"
        // in the JPEG spec, but we get good images without them. I think
        // this is for interleaved images?
        stream.pos += 3;

        // XXX -- investigate subsampled images better
        var mcuLayout = scanComponents.map(function(scanComponent) {
            var mcu = {};
            mcu.scanComponent = scanComponent;
            mcu.offset = 0;
            return mcu;
        });
        var mcuWidth = 8, mcuHeight = 8;
        var mcuSize = mcuWidth * mcuHeight;
        var numMCUs = (jpeg.expandedWidth * jpeg.expandedHeight) / mcuSize;

        var readBits = makeBitstream(stream);
        var offset = 0;
        var N = numMCUs;
        for (var i = 0; i < N; i++) {
            readMCU(readBits, jpeg, mcuLayout, offset);
            offset += mcuSize;
        }

        debug(jpeg);
    }

    function debug(jpeg) {
        var canvas = document.createElement("canvas");
        document.body.appendChild(canvas);
        canvas.width = jpeg.expandedWidth;
        canvas.height = jpeg.expandedHeight;
        var ctx = canvas.getContext("2d");

        var lumaPlane = jpeg.components[1].plane;

        for (var blockY = 0; blockY < jpeg.expandedWidth; blockY += 8) {
            for (var blockX = 0; blockX < jpeg.expandedHeight; blockX += 8) {
                var imgData = ctx.createImageData(8, 8);

                var offset = blockY * jpeg.expandedWidth + blockX * 8;

                for (var i = 0; i < 64; i++) {
                    imgData.data[i*4+0] = lumaPlane[offset+i];
                    imgData.data[i*4+1] = lumaPlane[offset+i];
                    imgData.data[i*4+2] = lumaPlane[offset+i];
                    imgData.data[i*4+3] = 255;
                }

                ctx.putImageData(imgData, blockX, blockY);
            }
        }
    }

    var segmentTypes = {};
    segmentTypes[0xD8] = "marker";
    segmentTypes[0xD9] = "marker";

    segmentTypes[0xDB] = parseDQT;
    segmentTypes[0xC0] = parseSOF;
    segmentTypes[0xC4] = parseDHT;
    segmentTypes[0xDA] = parseSOS;

    /*
    segmentTypes[0xDD] = parseDRI;
    */

    function parseSegment(stream, jpeg) {
        var marker = readByte(stream);
        if (marker !== 0xFF)
            console.error("welp", marker);

        var segmentType = readByte(stream);
        var func = segmentTypes[segmentType];
        if (func === "marker")
            return;

        var length = readWord(stream) - 2;
        if (func)
            func(stream, jpeg, length);
        else
            stream.pos += length;
    }

    function parseJpeg(stream) {
        var jpeg = {};
        jpeg.dcHuffmanTables = {};
        jpeg.acHuffmanTables = {};

        while (!eof(stream))
            parseSegment(stream, jpeg);

        return jpeg;
    }

    function loadJpeg(path) {
        var req = fetch(path);
        req.onload = function() {
            var stream = makeStream(req.response);
            parseJpeg(stream);
        };
    }

    exports.loadJpeg = loadJpeg;

})(window);
