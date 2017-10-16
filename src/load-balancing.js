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
let ClientInfo = null;

/**
 * Retrieve Edges from API
 * EdgeServers & ClientInfo get populated directly by this function if there's no error
 * Comment : The check for the edges property is for compatibility with an old API version, can remove when the new API is fully in prod.
 *
 * @param {getEdgeServersCallback} cb
 * @returns null (Callback)
 */
const getEdgesServers = function(cb) {
  GetAsync(edgesApiUri, function(err, result) {
    if (err) return cb(err);

    let tempObj = JSON.parse(result);

    if ('edges' in tempObj) {
      if ('client' in tempObj) {
        ClientInfo = tempObj.client;
      }

      EdgeServers = tempObj.edges;
      return cb();
    }
    else {
      EdgeServers = tempObj;
      return cb();
    }
  });
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
  // Need to check if there's multiple servers in the same DC
  // Else, everyone close will always connect to the first closest server
  // in the array, without caring about the latency (which should reflect the server load)
  let getBestDCPingEdge = function(sortedGeoEdge) {
    let sameDCArray = [sortedGeoEdge[0]];
    for (let i = 1; i < sortedGeoEdge.length; i++) {
      if (sortedGeoEdge[0].clientDistance == sortedGeoEdge[i].clientDistance) sameDCArray.push(sortedGeoEdge[i]);
      else break;
    }

    return sortEdgeListbyPing(sameDCArray)[0];
  }

  let sortedGeoEdge = sortEdgeListbyGeo(EdgeServers);
  sortedGeoEdge = removeDeadEdgeFromList(sortedGeoEdge);
  if (sortedGeoEdge.length > 0 && ClientInfo != null) {
    let closestEdge = sortedGeoEdge[0];
    if ('clientDistance' in closestEdge)
      if (closestEdge.clientDistance <= 1700) return getBestDCPingEdge(sortedGeoEdge);

    if ('country_code' in ClientInfo)
      if ('datacenter' in closestEdge)
        if ('countryCode' in closestEdge.datacenter)
          if (ClientInfo.country_code === closestEdge.datacenter.countryCode) return getBestDCPingEdge(sortedGeoEdge);
  }

  console.log("--- Geo Sorted List ---");
  console.log(sortedGeoEdge);

  return getBestPingEdge();
}

/**
 * Remove the edges that don't have the latency field
 * Comment: USE ONLY WITH CLONES
 * TODO:?
 */
const removeDeadEdgeFromList = function(edges) {
  for(var i = edges.length - 1; i >= 0; i--) {
    if(edges[i].latency == null) {
        edges.splice(i, 1);
    }
  }
  return edges;
}

/**
 * Find the best edge by ping
 *
 * @returns {Object} edge - Edge object
 */
const getBestPingEdge = function() {
  let sortedEdgeList = sortEdgeListbyPing(EdgeServers);
  sortedEdgeList = removeDeadEdgeFromList(sortedEdgeList);
  if (sortedEdgeList.length == 0) return null; // Empty array
  return sortedEdgeList[0];
}

const sortEdgeListbyGeo = function(edges) {
  let sortedList = edges.slice(0); // Clone array

  let sortFn = function(e1, e2) {
    if(e1.clientDistance == null && e2.clientDistance == null) return 0;
    if(e1.clientDistance == null) return 100000;
    if(e2.clientDistance == null) return -100000;

    return e1.clientDistance - e2.clientDistance;
  }

  return sortedList.sort(sortFn);
}

const sortEdgeListbyPing = function(edges) {
  let sortedList = edges.slice(0); // Clone array
  //let sortedList = edges; // Reference for tests

  let sortFn = function(e1, e2) {
    if(e1.latency == null && e2.latency == null) return 0;
    if(e1.latency == null) return 100000;
    if(e2.latency == null) return -100000;
    return e1.latency - e2.latency;
  }

  return sortedList.sort(sortFn);
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

const GetAsync = function(url, cb) {
  try {
    let Httpreq = new XMLHttpRequest(); // a new request

    Httpreq.onreadystatechange = function() {
      // The request is done and valid
      if (this.readyState == 4 && this.status == 200) {
        return cb(null, this.responseText)
      }
      else if (this.readyState == 4) {
        return cb({returnCode: this.status});
      }
    };

    Httpreq.open("GET", url, true);
    Httpreq.send();
  }
  catch(err) {
    return cb(err);
  }
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

const getDistanceEdge = function(edge, cb) {
  if (ClientInfo == null) return cb(); // Currently don't have the client info object
  if (ClientInfo.latitude == null || ClientInfo.longitude == null) return cb(); // Cannot proceed without client coordinates

  if (edge.datacenter == null || edge.datacenter.latitude == null || edge.datacenter.longitude == null) return cb(); // Cannot proceed without edge coordinates

  edge.clientDistance = distanceBetweenCoordinates(edge.datacenter.latitude, edge.datacenter.longitude, ClientInfo.latitude, ClientInfo.longitude);
  return cb();
}

/**
 * Distance between two points (Haversine formula)
 *
 * @return {float} distance - Distance between the two coordinates (approx)
 */
const distanceBetweenCoordinates = function(lat1, lon1, lat2, lon2) {
  var dLat = (lat2-lat1) * (Math.PI/180);
  var dLon = (lon2-lon1) * (Math.PI/180);
  var a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) *
    Math.sin(dLon/2) * Math.sin(dLon/2)
    ;
  var c = Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  var d = 6371 * 2 * c; // Distance in km

  return d;
}

// Pre-run flow to ping all edges and chose the best one
export function preRun(hls) {
  hls_ = hls;
  try {
    getEdgesServers(function(err) {
      async.each(EdgeServers, function(edge, cb) {
         getLatencyEdge(edge, function(err) {
           if (err) console.log(err);

           getDistanceEdge(edge, function(err) {
             if (err) console.log(err);
             return cb();
           });
         });
      }, function(err) {
        console.log(EdgeServers);
      });
    });
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
