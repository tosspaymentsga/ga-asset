/**
 * MOCK 사진 스토리지.
 *
 * Drive 폴더 ID 가 없는 개발/데모 환경에서 사용한다.
 * DriveService 와 동일한 인터페이스를 제공하므로 서비스 계층은 차이를 모른다.
 *
 * 이미지 본문은 CacheService 에 청크로 저장한다.
 * (Properties 는 총 500KB 제한이라 사진 저장에 적합하지 않다)
 * 캐시가 만료되면 미리보기만 사라지고 실사 기록 자체는 유지된다.
 */

var MOCK_PHOTO_CACHE_PREFIX = 'mockphoto:';
var MOCK_PHOTO_CHUNK = 80000;
var MOCK_PHOTO_TTL = 21600; // 6h

var MockStorage = {
  kind: 'MOCK',

  /**
   * @param {{campaignId:string, userEmail:string, assetId:string,
   *          base64:string, mimeType:string}} input
   * @return {{file_id:string, url:string}}
   */
  savePhoto: function (input) {
    var fileId = 'mock-' + Util.uuid();
    var base64 = input.base64 || '';

    var chunks = [];
    for (var i = 0; i < base64.length; i += MOCK_PHOTO_CHUNK) {
      chunks.push(base64.substring(i, i + MOCK_PHOTO_CHUNK));
    }
    for (var c = 0; c < chunks.length; c++) {
      Cache.put(MOCK_PHOTO_CACHE_PREFIX + fileId + ':' + c, chunks[c], MOCK_PHOTO_TTL);
    }
    Cache.put(
      MOCK_PHOTO_CACHE_PREFIX + fileId + ':meta',
      { n: chunks.length, mimeType: input.mimeType || 'image/jpeg' },
      MOCK_PHOTO_TTL
    );

    return {
      file_id: fileId,
      url: 'mock://photo/' + fileId
    };
  },

  /**
   * 미리보기용 data URL.
   * 권한 검사는 호출하는 서비스 계층에서 이미 끝난 상태여야 한다.
   * @return {string|null}
   */
  getPhotoDataUrl: function (fileId) {
    var meta = Cache.get(MOCK_PHOTO_CACHE_PREFIX + fileId + ':meta');
    if (!meta) return null;
    var base64 = '';
    for (var i = 0; i < meta.n; i++) {
      var chunk = Cache.get(MOCK_PHOTO_CACHE_PREFIX + fileId + ':' + i);
      if (chunk === null) return null;
      base64 += chunk;
    }
    return 'data:' + (meta.mimeType || 'image/jpeg') + ';base64,' + base64;
  }
};
