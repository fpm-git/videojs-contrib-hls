/**
 * @file load-balancing.js
 */

import m3u8 from 'm3u8-parser';
import PlaylistLoader from './playlist-loader';
import async from 'async';

let hls_;
let MainPlaylistSrc;
const edgesApiUri = 'https://floatplane.tk/api/edges';
const wmsAuthApiUri = 'https://linustechtips.com/main/applications/floatplane/interface/video_url.php?video_guid=1&video_quality=1';
const edgeQuery = '/manage/server_status';
let EdgeServers = [];

/**
 * Retrieve Edges from API
 *
 * @returns {Array} Array of Edges Object
 */
const getEdgesServers = function() {
  return JSON.parse(Get(edgesApiUri));
}

const getEdgeQueryURI = function(edge) {
  let domainIndex = edge.hostname.indexOf(".");
  if (domainIndex != -1) {
    let record = edge.hostname.substring(0, domainIndex);
    let finalURL = edge.hostname.replace(record, record + "-query");

    return 'https://' + finalURL;
  }
  else return 'https://' + edge.hostname;
}

const replaceHostnameFromString = function(uri, hostname) {
  var oldHostname = getHostnameFromURI(uri);

  return uri.replace(oldHostname, hostname);
}

const getHostnameFromURI = function(uri) {
  var indexStartHostname = uri.indexOf("://") + 3;
  if (indexStartHostname != -1) {
    var indexEndHostname = uri.indexOf("/", indexStartHostname);
    return uri.substring(indexStartHostname, indexEndHostname);
  }
  return null;
}

const getPortFromURI = function(uri) {
  var hostname = getHostnameFromURI(uri);

  var indexStartPort = uri.indexOf(":") + 1;
  if (indexStartPort != -1) {
    var indexEndPort = uri.indexOf("/", indexStartPort);
    if (indexEndPort == -1) {
      indexEndPort = uri.length;
    }
    return uri.substring(indexStartPort, indexEndPort);
  }
  return null;
}

const removePortFromURI = function(uri) {
  var port = getPortFromURI(uri);

  if (port) {
    return uri.replace(":" + port, "");
  }
  return uri;
}

const removeNimbleSessionIDFromURI = function(uri) {
  var indexStartSession = uri.indexOf("nimblesessionid=", indexEndHostname);
  if (indexStartSession != -1) {
    var indexEndSession = uri.indexOf("&", indexStartSession);
    var nimbleSession = uri.substring(indexStartSession, indexEndSession);
    uri = uri.replace(nimbleSession, "");
  }
  return uri;
}

const getParameterValueFromURI = function(uri, parameter) {
  var indexStartParam = uri.indexOf(parameter);
  if (indexStartParam != -1) {
    var indexEndParam = uri.indexOf("&", indexStartParam);
    if (indexEndParam != -1) {
      return uri.substring(indexStartParam + parameter.length, indexEndParam);
    }
    else {
      return uri.substring(indexStartParam + parameter.length, uri.length);
    }
  }
  // Param not found
  return null;
}

const replaceNimbeSessionIDFromURI = function(uri, id) {
  var param = "nimblesessionid=";
  var nimbleSessionId = getParameterValueFromURI(uri, param)

  if (nimbleSessionId != null)
  {
    return uri.replace("nimblesessionid=" + nimbleSessionId, "nimblesessionid=" + id)
  }
  return uri;
}

const getPlaylist = function(srcUrl, hls, withCredentials) {
  request = hls.xhr({
    uri: srcUrl,
    withCredentials
  }, function(error, req) {
    let parser;

    // disposed
    if (!request) {
      return;
    }

    // clear the loader's request reference
    request = null;

    if (error) {
      // Forbidden
      if (req.status == 403) {

      }
      // Cry
    }

    parser = new m3u8.Parser();
    parser.push(req.responseText);
    parser.end();

    parser.manifest.uri = srcUrl;

    // loaded a master playlist
    if (parser.manifest.playlists != null) {
      return parser.manifest.playlists;
    }
    return null;
  });
}

/**
 * Get best Edge from the current list. Edge must have there latency populated in order to be selected.
 *
 * @returns {Object} Edge, or null if none
 */
const getBestEdge = function() {
  var selectedEdge = null;
  for (var i = 0; i < EdgeServers.length; i++) {
    if (EdgeServers[i].latency != null) {
      if (selectedEdge == null) {
        selectedEdge = EdgeServers[i];
      }
      if (selectedEdge.latency > EdgeServers[i].latency) selectedEdge = EdgeServers[i];
    }
  }
  return selectedEdge;
}

/**
 * Retrieve Edges from API
 *
 * @returns {string} String from HTTP reply
 */
const Get = function(url) {
  var Httpreq = new XMLHttpRequest(); // a new request
  Httpreq.open("GET",url,false);
  Httpreq.send(null);
  return Httpreq.responseText;
}

const getLatencyEdge = function(edge, cb) {
  var start;
  var request = new XMLHttpRequest();
  request.timeout = 5000;

  try {
    request.onreadystatechange = function() {
      if (this.readyState == 4 && (this.status == 200 || this.status == 403 || this.status == 404)) {
        edge.latency = (new Date().getTime() - start);
        return cb();
      }
      else if (this.readyState == 4) {
        return cb({status: this.status, message: this.statusText});
      }
    }

    request.open("GET", getEdgeQueryURI(edge), true);
    start = new Date().getTime();
    request.send();
  }
  catch(err) {
    return cb(err);
  }
}

// Pre-run flow to ping all edges and chose the best one
export function preRun(hls) {
  hls_ = hls;
  try {
    let Httpreq = new XMLHttpRequest(); // a new request

    Httpreq.onreadystatechange = function() {
      // The request is done and valid
      if (this.readyState == 4 && this.status == 200) {
         EdgeServers = JSON.parse(this.responseText);

         async.each(EdgeServers, function(edge, cb) {
            getLatencyEdge(edge, function(err) {
              if (err) {
                console.log(err);
                return cb();
              }
              return cb();
            });
         }, function(err) {
           console.log(EdgeServers);
         });
      }
    };

    Httpreq.open("GET", edgesApiUri, true);
    Httpreq.send();
  }
  catch(err) {
    console.log(err);
  }
}

export function getSegmentURI(resolvedUri, hls) {
  if(MainPlaylistSrc != null) getPlaylistsEdges(MainPlaylistSrc, false, hls);
  var selectedEdge = getBestEdge();
  if (selectedEdge != null && selectedEdge.nimbleSessionId != null) {
    var segmentURI = replaceHostnameFromString(resolvedUri, selectedEdge.hostname);
    return replaceNimbeSessionIDFromURI(segmentURI, selectedEdge.nimbleSessionId);
  }
  else {
    return resolvedUri
  }
}

export function getPlaylistsEdges(srcUrl, withCredentials, hls) {
  if (MainPlaylistSrc == null) MainPlaylistSrc = srcUrl;
  let request;
  let edge = getBestEdge();
  if (!edge) return // No need to go further if we don't have an edge
  if (edge.nimbleSessionId != null) return // We already have the session ID

  let srcUrlHostname = removePortFromURI(getHostnameFromURI(srcUrl));

  // If the src hostname is the same as the best edge, don't download the playlist since we already have it in the PlaylistLoader
  if (edge.hostname.toLowerCase() === srcUrlHostname.toLowerCase()) return;

  let edgePlaylistURI = replaceHostnameFromString(srcUrl, edge.hostname);

  request = hls_.xhr({
    uri: edgePlaylistURI,
    withCredentials
  }, function(error, req) {
    let parser;

    // disposed
    if (!request) {
      return;
    }

    // clear the loader's request reference
    request = null;

    if (error) {
      // Forbidden
      if (req.status == 403) {
        segmentErrorHandler(edgePlaylistURI, hls)
      }
      //console.log(error);
      // Cry
    }

    parser = new m3u8.Parser();
    parser.push(req.responseText);
    parser.end();

    parser.manifest.uri = srcUrl;

    // loaded a master playlist
    if (parser.manifest.playlists[0] != null) {
      let lastDash = edgePlaylistURI.lastIndexOf("/");

      if (lastDash != -1) {
        let Httpreq = new XMLHttpRequest();

        let videoURL = edgePlaylistURI.substring(0, lastDash + 1);
        let chunkURL = videoURL + parser.manifest.playlists[0].uri;

        Httpreq.open("GET", chunkURL, true);
        Httpreq.send();
      }

      edge.nimbleSessionId = getParameterValueFromURI(parser.manifest.playlists[0].uri, "nimblesessionid=");
    }
    return null;
  });
}

// Refresh the current HLS playlist and refresh the nimbleSessionId if it exist
// for the edge that trown the error
export function segmentErrorHandler(segmentURI, hls) {
  // Get current playlist URI
  let segmentEdgeHostname = getHostnameFromURI(removePortFromURI(segmentURI));
  let oldMasterPlaylistURI = hls.masterPlaylistController_.masterPlaylistLoader_.master.uri;
  let oldWmsAuthSign = getParameterValueFromURI(oldMasterPlaylistURI, "wmsAuthSign=");
  let newWmsAuthSign;
  let newMasterPlaylistURI;;

  // Reset all nimbleSessionIds and call an update on the current edge;
  for (let i = 0; i < EdgeServers.length; i++) {
    delete EdgeServers[i].nimbleSessionId;
    if (EdgeServers[i].hostname.toLowerCase() === segmentEdgeHostname.toLowerCase()) getSegmentURI(segmentURI);
  }

  // Update wmsAuthSign
  try {
    $.ajax({
    	   url: wmsAuthApiUri,
    	   xhrFields: {
    		  withCredentials: true
    	   },
    	   success : function(data, statut){ // success est toujours en place, bien sûr !
           newWmsAuthSign = getParameterValueFromURI(data, "wmsAuthSign=");
           if (newWmsAuthSign != null) {
             newMasterPlaylistURI = oldMasterPlaylistURI.replace(oldWmsAuthSign, newWmsAuthSign);

             hls.masterPlaylistController_.masterPlaylistLoader_ = new PlaylistLoader(newMasterPlaylistURI, hls, false);
             hls.masterPlaylistController_.masterPlaylistLoader_.load();
           }
    	   },

    	   error : function(resultat, statut, erreur){

    	   }
    	});
  }
  catch(err) {
    console.log(err);
  }
}
