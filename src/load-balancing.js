/**
 * @file load-balancing.js
 */

import m3u8 from 'm3u8-parser';
import async from 'async';

let hls_;
let MainPlaylistSrc;
const edgesApiUri = 'https://floatplane.tk/api/edges';
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
  return 'https://' + edge.hostname;
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
      // Cry
    }

    parser = new m3u8.Parser();
    parser.push(req.responseText);
    parser.end();

    parser.manifest.uri = srcUrl;

    // loaded a master playlist
    if (parser.manifest.playlists) {
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
      if (this.readyState == 4 && (this.status == 200 || this.status == 404)) {
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
    var Httpreq = new XMLHttpRequest(); // a new request

    Httpreq.onreadystatechange = function() {
      // The request is done and valid
      if (this.readyState == 4 && this.status == 200) {
         EdgeServers = JSON.parse(this.responseText);

         async.each(EdgeServers, function(edge, cb) {
            var start = new Date().getTime();
            Get(getEdgeQueryURI(edge));
            edge.latency = (new Date().getTime() - start);
            cb();
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

export function getSegmentURI(resolvedUri) {
  if(MainPlaylistSrc != null) getPlaylistsEdges(MainPlaylistSrc, false);
  var selectedEdge = getBestEdge();
  if (selectedEdge != null && selectedEdge.nimbleSessionId != null) {
    var segmentURI = replaceHostnameFromString(resolvedUri, selectedEdge.hostname);
    return replaceNimbeSessionIDFromURI(segmentURI, selectedEdge.nimbleSessionId);
  }
  else {
    return resolvedUri
  }
}

export function getPlaylistsEdges(srcUrl, withCredentials) {
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
      console.log(error);
      // Cry
    }

    parser = new m3u8.Parser();
    parser.push(req.responseText);
    parser.end();

    parser.manifest.uri = srcUrl;

    // loaded a master playlist
    if (parser.manifest.playlists[0]) {
      edge.nimbleSessionId = getParameterValueFromURI(parser.manifest.playlists[0].uri, "nimblesessionid=");
    }
    return null;
  });
}
