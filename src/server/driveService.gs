/**
 * Google Drive 사진 스토리지.
 *
 * 폴더 구조(§10):
 *   Asset Audit / {campaign_id} / {user_email} / {asset_id}_{timestamp}.jpg
 *
 * - Sheet 에는 이미지 바이너리를 저장하지 않고 photo_file_id / photo_url 만 저장한다.
 * - 폴더 탐색은 매 요청 반복하면 느리므로 경로별 폴더 ID 를 Properties 에 캐싱한다.
 * - 파일 공개 공유는 하지 않는다. 열람은 서버 RPC(getPhotoDataUrl)를 통해서만 가능하다.
 */

var DRIVE_FOLDER_PROP_PREFIX = 'GA_DRIVE_FOLDER_';

var DriveService = {
  kind: 'DRIVE',

  _rootFolder: function () {
    var id = Util.trim(Config.get('DRIVE_ROOT_FOLDER_ID'));
    if (id) return DriveApp.getFolderById(id);

    var name = Config.get('DRIVE_ROOT_FOLDER_NAME');
    var cachedId = PropertiesService.getScriptProperties().getProperty(
      DRIVE_FOLDER_PROP_PREFIX + 'ROOT'
    );
    if (cachedId) {
      try {
        return DriveApp.getFolderById(cachedId);
      } catch (err) {
        // 삭제되었을 수 있으므로 아래에서 다시 만든다
      }
    }
    var it = DriveApp.getFoldersByName(name);
    var folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
    PropertiesService.getScriptProperties().setProperty(
      DRIVE_FOLDER_PROP_PREFIX + 'ROOT',
      folder.getId()
    );
    return folder;
  },

  /** 하위 폴더를 얻거나 만든다 (경로별 ID 캐싱) */
  _childFolder: function (parent, name, cacheKey) {
    var props = PropertiesService.getScriptProperties();
    var cachedId = props.getProperty(DRIVE_FOLDER_PROP_PREFIX + cacheKey);
    if (cachedId) {
      try {
        return DriveApp.getFolderById(cachedId);
      } catch (err) {
        // 캐시 무효 — 아래에서 재생성
      }
    }
    var it = parent.getFoldersByName(name);
    var folder = it.hasNext() ? it.next() : parent.createFolder(name);
    props.setProperty(DRIVE_FOLDER_PROP_PREFIX + cacheKey, folder.getId());
    return folder;
  },

  savePhoto: function (input) {
    try {
      var root = this._rootFolder();
      var campaignFolder = this._childFolder(
        root,
        input.campaignId,
        'C_' + input.campaignId
      );
      var userFolder = this._childFolder(
        campaignFolder,
        input.userEmail,
        'U_' + input.campaignId + '_' + input.userEmail
      );

      var stamp = Utilities.formatDate(
        new Date(),
        Session.getScriptTimeZone() || 'Asia/Seoul',
        'yyyyMMdd_HHmmss'
      );
      var ext = (input.mimeType || 'image/jpeg').indexOf('png') >= 0 ? 'png' : 'jpg';
      var name =
        Util.safeFileName(input.assetId || 'unlisted') + '_' + stamp + '.' + ext;

      var blob = Utilities.newBlob(
        Utilities.base64Decode(input.base64),
        input.mimeType || 'image/jpeg',
        name
      );
      var file = userFolder.createFile(blob);
      // 공개 공유하지 않는다. 열람은 서버를 통해서만.
      return { file_id: file.getId(), url: file.getUrl() };
    } catch (err) {
      throw new AppError('PHOTO_FAILED', ERROR_MESSAGES.PHOTO_FAILED, String(err));
    }
  },

  getPhotoDataUrl: function (fileId) {
    try {
      var file = DriveApp.getFileById(fileId);
      var blob = file.getBlob();
      return (
        'data:' +
        blob.getContentType() +
        ';base64,' +
        Utilities.base64Encode(blob.getBytes())
      );
    } catch (err) {
      return null;
    }
  }
};

/** 스토리지 선택 (Drive 폴더가 설정되어 있으면 Drive, 아니면 Mock) */
var PhotoStorage = {
  impl: function () {
    if (Config.isMock() && !Util.trim(Config.get('DRIVE_ROOT_FOLDER_ID'))) {
      return MockStorage;
    }
    return DriveService;
  },

  savePhoto: function (input) { return this.impl().savePhoto(input); },
  getPhotoDataUrl: function (fileId) { return this.impl().getPhotoDataUrl(fileId); }
};
