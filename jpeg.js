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

    function readLong(stream) {
        return stream.getUint32((stream.pos += 4) - 4);
    }

    function readFloat(stream) {
        return stream.getFloat32((stream.pos += 4) - 4);
    }

    function readSWord(stream) {
        return stream.getInt16((stream.pos += 2) - 2);
    }

    function readSByte(stream) {
        return stream.getInt8(stream.pos++);
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

    function read0String(stream) {
        var S = "";
        while (true) {
            var c = readByte(stream);
            if (c == 0)
                break;
            S += String.fromCharCode(c);
        }
        return S;
    }

    function fetch(path) {
        var request = new XMLHttpRequest();
        request.open("GET", path, true);
        request.responseType = "arraybuffer";
        request.send();
        return request;
    }

    function parseDQT(stream, jpeg, length) {
    	jpeg.quantizationTables = [];

    	while (length > 0) {
	    	var info = readByte(stream);
	    	var precision = (info & 0xF0);
	    	var tableId = (info & 0x0F);

	    	var table;
	    	if (precision === 0) {
	    		table = collect(stream, readByte, 64);
	    		length -= 1 + 64;
	    	} else {
	    		table = collect(stream, readWord, 64);
	    		length -= 1 + 64 * 2;
	    	}

	    	jpeg.quantizationTables[tableId] = table;
	    }
    }

    function parseSOF(stream, jpeg, length) {
    	var precision = readByte(stream);
    	if (precision !== 8)
    		console.error("bad precision");

    	jpeg.height = readWord(stream);
    	jpeg.width = readWord(stream);

    	var components = readByte(stream);
    	if (components !== 3)
    		console.error("bad components");

    	jpeg.components = {};

    	function parseComponent(stream) {
    		var id = readByte(stream);
    		var samplingFactors = readByte(stream);
    		var quantizationTableId = readByte(stream);

    		var component = {};
    		component.horzSample = (samplingFactors & 0xF0);
    		component.vertSample = (samplingFactors & 0x0F);
    		component.quantizationTableId = quantizationTableId;

    		jpeg.components[id] = component;
    	}

    	for (var i = 0; i < components; i++)
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

            if (nValues == 0)
                return;

            var values = collect(stream, readByte, nValues);
            values.forEach(function(value) {
                table[huffmanCodeString(code)] = value;
                code++;
            });

            code <<= 1;
        });

        return table;
    }

    function parseDHT(stream, jpeg, length) {
    	jpeg.huffmanTrees = [];

    	while (length > 0) {
	    	var info = readByte(stream);
	    	var type = (info & 0xF0);
	    	var tableId = (info & 0x0F);

	    	var table = parseHuffmanTable(stream);
	    	jpeg.huffmanTrees[tableId] = table;
            var nKeys = Object.keys(table).length;
	    	length -= 1 + nKeys + 1;
	    }
    }

    var segmentTypes = {};
    segmentTypes[0xD8] = "marker";
    segmentTypes[0xD9] = "marker";

    segmentTypes[0xDB] = parseDQT;
    segmentTypes[0xC0] = parseSOF;
    segmentTypes[0xC4] = parseDHT;

    /*
    segmentTypes[0xDA] = parseSOS;
    segmentTypes[0xDD] = parseDRI;

    */

    function parseSegment(stream, jpeg) {
        function synchronizeToNextSegment(stream) {
            while (marker == )
        }

    	var segmentType = marker;
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