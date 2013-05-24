(function(exports) {

    function makeCanvas(gif) {
        var canvas = document.createElement("canvas");
        canvas.width = gif.lsWidth;
        canvas.height = gif.lsHeight;
        return canvas;
    }

    function paintImageBlock(ctx, gif, img) {
        var tbl = img.colorTable || gif.colorTable;
        var imgData = ctx.getImageData(img.left, img.top, img.width, img.height);
        var i, o = 0, n = img.output.length;
        for (i = 0; i < n; i++) {
            var pixel = img.output[i];
            imgData.data[o++] = tbl[pixel].r;
            imgData.data[o++] = tbl[pixel].g;
            imgData.data[o++] = tbl[pixel].b;
            imgData.data[o++] = 255;
        }
        ctx.putImageData(imgData, img.left, img.top);
    }

    window.addEventListener('load', function() {
        loadGif(location.origin + '/marbles.gif', function(gif) {
            var canvas = makeCanvas(gif);
            var ctx = canvas.getContext('2d');
            paintImageBlock(ctx, gif, gif.images[0]);
            document.body.appendChild(canvas);
        });
    });

})(window);
