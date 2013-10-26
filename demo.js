(function(exports) {

    var base = location.href.split('/').slice(0, -1).join('/') + '/';

    window.addEventListener('load', function() {
    	if (false) {
	        var gifs = ['horse.gif', 'bob.gif', 'earth.gif', 'light.gif'];
	        gifs.forEach(function(filename) {
	            var uri = base + filename;
	            var gif = runGif(uri);
	            document.body.appendChild(gif);
	        });
	    } else {
	    	var jpgs = ['lenaTest3.jpg'];
	    	jpgs.forEach(function(filename) {
	    		var uri = base + filename;
	    		var jpg = loadJpeg(uri);
	    	});
	    }
    });

})(window);
