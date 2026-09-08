/**
 * Web App Entry Point + 클라이언트 RPC.
 *
 * - doGet(e): 하나의 공용 URL 로 접속하는 진입점 (§3)
 * - 모든 RPC 는 rpcEnvelope() 로 감싸 예외를 사용자 친화적 메시지로 변환한다(§21)
 *   → 클라이언트에는 항상 { ok:boolean, data?:any, code?:string, message?:string } 형태만 전달된다.
 *   → Apps Script 내부 오류 문자열은 절대 그대로 노출하지 않는다.
 */

function doGet(e) {
  var template = HtmlService.createTemplateFromFile('index');
  template.initialState = JSON.stringify(buildInitialState_());
  template.appName = Config.get('APP_NAME');

  return template
    .evaluate()
    .setTitle(Config.get('APP_NAME'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** HTML 파일 include 헬퍼 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * 첫 화면에 필요한 데이터를 서버에서 미리 담아 내려보낸다.
 * (모바일에서 최초 로딩 왕복을 한 번 줄이기 위함)
 */
function buildInitialState_() {
  try {
    var user = Auth.getCurrentUser();
    if (!user) {
      return {
        ok: false,
        code: 'NOT_SIGNED_IN',
        message: ERROR_MESSAGES.NOT_SIGNED_IN,
        demoUsers: Auth.listMockUsers()
      };
    }
    return {
      ok: true,
      data: AssetService.getMyAuditView(user),
      demoUsers: Auth.listMockUsers()
    };
  } catch (err) {
    var handled = handleError_('doGet', err);
    return {
      ok: false,
      code: handled.code,
      message: handled.message,
      demoUsers: safeDemoUsers_()
    };
  }
}

function safeDemoUsers_() {
  try {
    return Auth.listMockUsers();
  } catch (err) {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 공통 에러 처리                                                      */
/* ------------------------------------------------------------------ */

function handleError_(fnName, err) {
  var isApp = err && err.isAppError;
  var code = isApp ? err.code : 'UNEXPECTED';
  var message = isApp
    ? err.message
    : '처리 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.';
  var detail = isApp
    ? err.detail
    : (err && (err.stack || err.message)) || String(err);

  try {
    Logger.log('[' + fnName + '] ' + code + ' / ' + detail);
    Repository.logError({
      user_email: (Auth.getCurrentUser() || {}).email || '',
      fn: fnName,
      message: message,
      detail: String(detail).substring(0, 900)
    });
  } catch (logErr) {
    // 로깅 실패는 무시한다
  }

  return { ok: false, code: code, message: message };
}

/** RPC 공통 래퍼 */
function rpcEnvelope_(fnName, handler) {
  try {
    return { ok: true, data: handler() };
  } catch (err) {
    return handleError_(fnName, err);
  }
}

/* ------------------------------------------------------------------ */
/* 직원용 RPC (§20)                                                    */
/* ------------------------------------------------------------------ */

/** 내 자산 + 진행률 + 옵션 (첫 화면 전체 데이터) */
function getMyAssets() {
  return rpcEnvelope_('getMyAssets', function () {
    return AssetService.getMyAuditView(Auth.requireUser());
  });
}

/** 진행 상태만 필요할 때 */
function getMyAuditStatus() {
  return rpcEnvelope_('getMyAuditStatus', function () {
    var user = Auth.requireUser();
    return AssetService.getMyAuditView(user).progress;
  });
}

function verifyQr(scannedTag, expectedAssetId) {
  return rpcEnvelope_('verifyQr', function () {
    return AuditService.verifyQr(Auth.requireUser(), scannedTag, expectedAssetId);
  });
}

function registerForeignScan(scannedTag, expectedAssetId) {
  return rpcEnvelope_('registerForeignScan', function () {
    return AuditService.registerForeignScan(
      Auth.requireUser(),
      scannedTag,
      expectedAssetId
    );
  });
}

function submitPhoto(assetId, base64, mimeType) {
  return rpcEnvelope_('submitPhoto', function () {
    return AuditService.submitPhoto(Auth.requireUser(), assetId, base64, mimeType);
  });
}

function submitException(assetId, exceptionType, note) {
  return rpcEnvelope_('submitException', function () {
    return AuditService.submitException(
      Auth.requireUser(),
      assetId,
      exceptionType,
      note
    );
  });
}

function submitUnlistedAsset(tag, note, base64, mimeType) {
  return rpcEnvelope_('submitUnlistedAsset', function () {
    return AuditService.submitUnlistedAsset(
      Auth.requireUser(),
      tag,
      note,
      base64,
      mimeType
    );
  });
}

function getPhotoDataUrl(fileId) {
  return rpcEnvelope_('getPhotoDataUrl', function () {
    return AuditService.getPhotoDataUrl(Auth.requireUser(), fileId);
  });
}

/* ------------------------------------------------------------------ */
/* 관리자 RPC                                                          */
/* ------------------------------------------------------------------ */

function getAdminDashboard(campaignId) {
  return rpcEnvelope_('getAdminDashboard', function () {
    Auth.requireAdmin();
    return AdminService.getDashboard(campaignId);
  });
}

function getAdminAuditList(filters) {
  return rpcEnvelope_('getAdminAuditList', function () {
    Auth.requireAdmin();
    return AdminService.getAuditList(filters);
  });
}

function getAdminReconciliation(filters) {
  return rpcEnvelope_('getAdminReconciliation', function () {
    Auth.requireAdmin();
    return AdminService.getReconciliation(filters);
  });
}

function resolveReviewItem(key, state, note) {
  return rpcEnvelope_('resolveReviewItem', function () {
    var admin = Auth.requireAdmin();
    return AdminService.resolveReviewItem(admin, key, state, note);
  });
}

/* ------------------------------------------------------------------ */
/* PoC 데모 전용 RPC (ALLOW_MOCK_USER=false 이면 모두 거부)             */
/* ------------------------------------------------------------------ */

function devSignInAs(email) {
  return rpcEnvelope_('devSignInAs', function () {
    Auth.signInAsMockUser(email);
    return AssetService.getMyAuditView(Auth.requireUser());
  });
}

function devResetMyAudit() {
  return rpcEnvelope_('devResetMyAudit', function () {
    if (!Config.bool('ALLOW_MOCK_USER')) {
      throw new AppError('FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, 'demo reset disabled');
    }
    var user = Auth.requireUser();
    var campaign = AssetService.getActiveCampaign();
    Repository.resetUserAudit(campaign.campaign_id, user.email);
    Cache.remove('dashboard:' + campaign.campaign_id);
    return AssetService.getMyAuditView(user);
  });
}
