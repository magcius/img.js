(function(exports) {

    function makeCanvas(gif) {
        var canvas = document.createElement("canvas");
        canvas.width = gif.width;
        canvas.height = gif.height;
        return canvas;
    }

    function drawCommand(ctx, command) {
        var imgData = ctx.getImageData(command.left, command.top, command.width, command.height);
        var i, o = 0, n = command.indices.length;
        var data = imgData.data;
        for (i = 0; i < n; i++) {
            var index = command.indices[i];
            if (index == command.transparentPixel) {
            	data[o++] = 0;
            	data[o++] = 0;
            	data[o++] = 0;
            	data[o++] = 0;
            } else {
	            data[o++] = command.colorTable[index].r;
	            data[o++] = command.colorTable[index].g;
	            data[o++] = command.colorTable[index].b;
	            data[o++] = 255;
            }
        }
        ctx.putImageData(imgData, command.left, command.top);
    }

    var commands = {
    	'draw': drawCommand,
    };

    // default duration is 1/10th of a second
    var DEFAULT_DURATION = (1 / 10) * 1000;
    var MIN_DURATION = 20;

    function runCommands(ctx, gif) {
    	var command;
    	var idx = 0;

    	function runCommand() {
    		command = gif.commands[idx];
    		var func = commands[command.type];
    		func(ctx, command);
    		scheduleNextCommand();
    	}

    	function nextCommand() {
    		idx = (idx + 1) % gif.commands.length;
    		runCommand();
    	}

    	function scheduleNextCommand() {
    		var duration = command.duration;
    		if (duration === undefined || duration < MIN_DURATION)
    			duration = DEFAULT_DURATION;

    		setTimeout(nextCommand, duration);
    	}

    	runCommand();
    }

    window.addEventListener('load', function() {
        loadGif(location.origin + '/light.gif', function(gif) {
            var canvas = makeCanvas(gif);
            document.body.appendChild(canvas);
            var ctx = canvas.getContext('2d');
            runCommands(ctx, gif);
        });
    });

})(window);
