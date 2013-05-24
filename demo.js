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
        for (i = 0; i < n; i++) {
            var index = command.indices[i];
            imgData.data[o++] = command.colorTable[index].r;
            imgData.data[o++] = command.colorTable[index].g;
            imgData.data[o++] = command.colorTable[index].b;
            imgData.data[o++] = 255;
        }
        ctx.putImageData(imgData, command.left, command.top);
    }

    var commands = {
    	'draw': drawCommand,
    };

    window.addEventListener('load', function() {
        loadGif(location.origin + '/marbles.gif', function(gif) {
            var canvas = makeCanvas(gif);
            document.body.appendChild(canvas);
            var ctx = canvas.getContext('2d');

            gif.commands.forEach(function(command) {
            	var func = commands[command.type];
            	func(ctx, command);
            });
        });
    });

})(window);
