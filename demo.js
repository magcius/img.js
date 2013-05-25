(function(exports) {

    window.addEventListener('load', function() {
        loadGif(location.origin + '/earth.gif', function(gif) {
            var gif = runGif(gif);
            document.body.appendChild(gif);
        });
    });

})(window);
