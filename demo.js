(function(exports) {

    function makeCanvas(gif) {
        var canvas = document.createElement("canvas");
        canvas.width = gif.width;
        canvas.height = gif.height;
        canvas.style.position = "absolute";
        canvas.style.left = "0px";
        canvas.style.top = "0px";
        return canvas;
    }

    function drawCommand(canvas, command) {
        var ctx = canvas.getContext('2d');
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

    var commands = {
        'draw': drawCommand,
    };

    // default duration is 1/10th of a second
    var DEFAULT_DURATION = (1 / 10) * 1000;
    var MIN_DURATION = 20;

    function runGif(gif) {
        var command;
        var idx = 0;

        // Images from composite commands are added to the
        // temporary canvas first, and at the start of a new
        // composite command, they're "disposed" of into the
        // composite canvas if necessary.
        var compositeCanvas = makeCanvas(gif);
        var temporaryCanvas = makeCanvas(gif);

        var container = document.createElement("gif-container");
        container.style.position = "relative";
        container.appendChild(compositeCanvas);
        container.appendChild(temporaryCanvas);

        function runCommand() {
            command = gif.commands[idx];
            var func = commands[command.type];
            // Commands are always first drawn into the temp
            // canvas. The disposal at the start of the next
            // next command will put things into the
            // composite canvas if wanted.
            func(temporaryCanvas, command);
            scheduleNextCommand();
        }

        function nextCommand() {
            disposeImage(temporaryCanvas, compositeCanvas, command)
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

        return container;
    }

    window.addEventListener('load', function() {
        loadGif(location.origin + '/earth.gif', function(gif) {
            var gif = runGif(gif);
            document.body.appendChild(gif);
        });
    });

})(window);
