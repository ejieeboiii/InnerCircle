require('esbuild').buildSync({entryPoints:['scripts/blob-client.js'],bundle:true,minify:true,format:'iife',globalName:'InnerCircleMedia',outfile:'public/js/blob-client.js',platform:'browser'});
