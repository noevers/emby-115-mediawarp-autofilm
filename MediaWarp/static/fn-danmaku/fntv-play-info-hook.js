!function(){
  if (typeof window === 'undefined' || window.__MediaWarpFNTVPlayInfo) return;

  const store = window.__MediaWarpFNTVPlayInfo = {
    latest: null,
    byGuid: Object.create(null),
    put(data, req) {
      if (!data || typeof data !== 'object') return;
      const item = data.item || {};
      this.latest = data;
      [
        req && req.item_guid,
        req && req.media_guid,
        data.guid,
        data.media_guid,
        data.video_guid,
        item.guid,
        item.play_item_guid,
        item.parent_guid,
      ].filter(Boolean).forEach(guid => {
        this.byGuid[guid] = data;
      });
    },
    get(guid) {
      return guid && this.byGuid[guid] || this.latest || null;
    },
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;

  window.fetch = async function(input, init) {
    let requestBody = null;
    try {
      if (init && typeof init.body === 'string') {
        requestBody = JSON.parse(init.body);
      } else if (input && typeof Request !== 'undefined' && input instanceof Request) {
        const text = await input.clone().text();
        requestBody = text ? JSON.parse(text) : null;
      }
    } catch (_) {}

    const response = await nativeFetch.apply(this, arguments);

    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && /^(?:\/v)?\/api\/v1\/play\/info$/.test(new URL(url, location.origin).pathname)) {
        response.clone().json().then(json => {
          if (json && json.code === 0 && json.data) store.put(json.data, requestBody);
        }).catch(function(){});
      }
    } catch (_) {}

    return response;
  };
}();
