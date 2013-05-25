(function(exports) {

    window.addEventListener('load', function() {
        var gifs = ['horse.gif', 'bob.gif', 'earth.gif', 'light.gif'];
        gifs.forEach(function(filename) {
            var url = location.origin + '/' + filename;
            var gif = runGif(url);
            document.body.appendChild(gif);
        });
    });

})(window);
