(function(exports) {

    window.addEventListener('load', function() {
        loadGif(location.origin + '/bob.gif', function(gif) {
            var gif = runGif(gif);
            document.body.appendChild(gif);
        });
    });

})(window);
