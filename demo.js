(function(exports) {

    window.addEventListener('load', function() {
        var gif = runGif(location.origin + '/bob.gif');
        document.body.appendChild(gif);
    });

})(window);
