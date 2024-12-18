/**
 * This module interacts with the server used to cache video ad content to be restored later.
 * At a high level, the expected workflow goes like this:
 *
 *   - Request video ads from Bidders
 *   - Generate IDs for each valid bid, and cache the key/value pair on the server.
 *   - Return these IDs so that publishers can use them to fetch the bids later.
 *
 * This trickery helps integrate with ad servers, which set character limits on request params.
 */

import {ajaxBuilder} from './ajax.js';
import {config} from './config.js';
import {auctionManager} from './auctionManager.js';
import {logError, logWarn} from './utils.js';
import {addBidToAuction} from './auction.js';

/**
 * Might be useful to be configurable in the future
 * Depending on publisher needs
 */
const ttlBufferInSeconds = 15;

/**
 * @typedef {object} CacheableUrlBid
 * @property {string} vastUrl A URL which loads some valid VAST XML.
 */

/**
 * @typedef {object} CacheablePayloadBid
 * @property {string} vastXml Some VAST XML which loads an ad in a video player.
 */

/**
 * A CacheableBid describes the types which the videoCache can store.
 *
 * @typedef {CacheableUrlBid|CacheablePayloadBid} CacheableBid
 */

/**
 * Function which wraps a URI that serves VAST XML, so that it can be loaded.
 *
 * @param {string} uri The URI where the VAST content can be found.
 * @param {(string|string[])} impTrackerURLs An impression tracker URL for the delivery of the video ad
 * @return A VAST URL which loads XML from the given URI.
 */
function wrapURI(uri, impTrackerURLs) {
  impTrackerURLs = impTrackerURLs && (Array.isArray(impTrackerURLs) ? impTrackerURLs : [impTrackerURLs]);
  // Technically, this is vulnerable to cross-script injection by sketchy vastUrl bids.
  // We could make sure it's a valid URI... but since we're loading VAST XML from the
  // URL they provide anyway, that's probably not a big deal.
  let impressions = impTrackerURLs ? impTrackerURLs.map(trk => `<Impression><![CDATA[${trk}]]></Impression>`).join('') : '';
  return `<VAST version="3.0">
    <Ad>
      <Wrapper>
        <AdSystem>prebid.org wrapper</AdSystem>
        <VASTAdTagURI><![CDATA[${uri}]]></VASTAdTagURI>
        ${impressions}
        <Creatives></Creatives>
      </Wrapper>
    </Ad>
  </VAST>`;
}

export const vastsLocalCache = new Map();

export const LOCAL_CACHE_MOCK_URL = 'https://local.prebid.org/cache?bidder=';

/**
 * Wraps a bid in the format expected by the prebid-server endpoints, or returns null if
 * the bid can't be converted cleanly.
 *
 * @param {CacheableBid} bid
 * @param {Object} [options] - Options object.
 * @param {Object} [options.index=auctionManager.index] - Index object, defaulting to `auctionManager.index`.
 * @return {Object|null} - The payload to be sent to the prebid-server endpoints, or null if the bid can't be converted cleanly.
 */
function toStorageRequest(bid, {index = auctionManager.index} = {}) {
  const vastValue = getVastValue(bid);
  const auction = index.getAuction(bid);
  const ttlWithBuffer = Number(bid.ttl) + ttlBufferInSeconds;
  let payload = {
    type: 'xml',
    value: vastValue,
    ttlseconds: ttlWithBuffer
  };

  if (config.getConfig('cache.vasttrack')) {
    payload.bidder = bid.bidder;
    payload.bidid = bid.requestId;
    payload.aid = bid.auctionId;
  }

  if (auction != null) {
    payload.timestamp = auction.getAuctionStart();
  }

  if (typeof bid.customCacheKey === 'string' && bid.customCacheKey !== '') {
    payload.key = bid.customCacheKey;
  }

  return payload;
}

/**
 * A function which should be called with the results of the storage operation.
 *
 * @callback videoCacheStoreCallback
 *
 * @param {Error} [error] The error, if one occurred.
 * @param {?string[]} uuids An array of unique IDs. The array will have one element for each bid we were asked
 *   to store. It may include null elements if some of the bids were malformed, or an error occurred.
 *   Each non-null element in this array is a valid input into the retrieve function, which will fetch
 *   some VAST XML which can be used to render this bid's ad.
 */

/**
 * A function which bridges the APIs between the videoCacheStoreCallback and our ajax function's API.
 *
 * @param {videoCacheStoreCallback} done A callback to the "store" function.
 * @return {Function} A callback which interprets the cache server's responses, and makes up the right
 *   arguments for our callback.
 */
function shimStorageCallback(done) {
  return {
    success: function (responseBody) {
      let ids;
      try {
        ids = JSON.parse(responseBody).responses
      } catch (e) {
        done(e, []);
        return;
      }

      if (ids) {
        done(null, ids);
      } else {
        done(new Error("The cache server didn't respond with a responses property."), []);
      }
    },
    error: function (statusText, responseBody) {
      done(new Error(`Error storing video ad in the cache: ${statusText}: ${JSON.stringify(responseBody)}`), []);
    }
  }
}

function getVastValue(bid) {
  return bid.vastXml ? bid.vastXml : wrapURI(bid.vastUrl, bid.vastImpUrl);
};

/**
 * If the given bid is for a Video ad, generate a unique ID and cache it somewhere server-side.
 *
 * @param {CacheableBid[]} bids A list of bid objects which should be cached.
 * @param {videoCacheStoreCallback} [done] An optional callback which should be executed after
 * the data has been stored in the cache.
 */
export function store(bids, done, getAjax = ajaxBuilder) {
  const requestData = {
    puts: bids.map(toStorageRequest)
  };
  const ajax = getAjax(config.getConfig('cache.timeout'));
  ajax(config.getConfig('cache.url'), shimStorageCallback(done), JSON.stringify(requestData), {
    contentType: 'text/plain',
    withCredentials: true
  });
}

export function getCacheUrl(id) {
  return `${config.getConfig('cache.url')}?uuid=${id}`;
}

export const storeLocally = (bid) => {
  const vastValue = getVastValue(bid);
  const dataUri = 'data:text/xml;base64,' + btoa(vastValue);
  bid.vastUrl = dataUri;
  //@todo: think of wrapping it with [if (adServer)]
  vastsLocalCache.set(getLocalCacheBidId(bid), dataUri);
};

export async function getLocalCachedBidWithGam(adTagUrl) {
  const gamAdTagUrl = new URL(adTagUrl);
  const custParams = new URLSearchParams(gamAdTagUrl.searchParams.get('cust_params'));
  const hb_bidder = custParams.get('hb_bidder');
  const hb_adid = custParams.get('hb_adid');
  const response = await fetch(gamAdTagUrl);

  if (!response.ok) {
    logError('Unable to fetch valid response from Google Ad Manager');
    return;
  }

  const gamVastWrapper = await response.text();
  const bidVastDataUri = vastsLocalCache.get(`${hb_bidder}_${hb_adid}`);
  const mockUrl = LOCAL_CACHE_MOCK_URL + hb_bidder;
  const combinedVast = gamVastWrapper.replace(mockUrl, bidVastDataUri);

  return combinedVast;
}

const getLocalCacheBidId = (bid) => `${bid.bidderCode}_${bid.adId}`;

export const _internal = {
  store
}

export function storeBatch(batch) {
  const bids = batch.map(entry => entry.bidResponse)
  function err(msg) {
    logError(`Failed to save to the video cache: ${msg}. Video bids will be discarded:`, bids)
  }
  _internal.store(bids, function (error, cacheIds) {
    if (error) {
      err(error)
    } else if (batch.length !== cacheIds.length) {
      logError(`expected ${batch.length} cache IDs, got ${cacheIds.length} instead`)
    } else {
      cacheIds.forEach((cacheId, i) => {
        const {auctionInstance, bidResponse, afterBidAdded} = batch[i];
        if (cacheId.uuid === '') {
          logWarn(`Supplied video cache key was already in use by Prebid Cache; caching attempt was rejected. Video bid must be discarded.`);
        } else {
          bidResponse.videoCacheKey = cacheId.uuid;
          if (!bidResponse.vastUrl) {
            bidResponse.vastUrl = getCacheUrl(bidResponse.videoCacheKey);
          }
          addBidToAuction(auctionInstance, bidResponse);
          afterBidAdded();
        }
      });
    }
  });
};

let batchSize, batchTimeout, cleanupHandler;
if (FEATURES.VIDEO) {
  config.getConfig('cache', ({cache}) => {
    batchSize = typeof cache.batchSize === 'number' && cache.batchSize > 0
      ? cache.batchSize
      : 1;
    batchTimeout = typeof cache.batchTimeout === 'number' && cache.batchTimeout > 0
      ? cache.batchTimeout
      : 0;

    // removing blobs that are not going to be used
    if (cache.useLocal && !cleanupHandler) {
      cleanupHandler = auctionManager.onExpiry((auction) => {
        auction.getBidsReceived()
          .forEach((bid) => vastsLocalCache.delete(getLocalCacheBidId(bid)))
      });
    }
  });
}

export const batchingCache = (timeout = setTimeout, cache = storeBatch) => {
  let batches = [[]];
  let debouncing = false;
  const noTimeout = cb => cb();

  return function (auctionInstance, bidResponse, afterBidAdded) {
    const batchFunc = batchTimeout > 0 ? timeout : noTimeout;
    if (batches[batches.length - 1].length >= batchSize) {
      batches.push([]);
    }

    batches[batches.length - 1].push({auctionInstance, bidResponse, afterBidAdded});

    if (!debouncing) {
      debouncing = true;
      batchFunc(() => {
        batches.forEach(cache);
        batches = [[]];
        debouncing = false;
      }, batchTimeout);
    }
  };
};

export const batchAndStore = batchingCache();
