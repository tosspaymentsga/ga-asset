/**
 * 인증 / 권한.
 *
 * 원칙(§4): 사용자 식별은 전적으로 서버에서 수행한다.
 * 클라이언트가 email 이나 userId 를 보내 자신의 신원을 주장하는 경로는 존재하지 않는다.
 *
 * 실제 Workspace 배포에서 Session.getActiveUser().getEmail() 이 빈 문자열을 반환할 수 있어
 * (배포 설정 "실행 주체 = 사용자", "액세스 권한 = 도메인 내 사용자" 필요)
 * 이메일 확보 로직을 이 파일 한 곳으로 격리했다.
 */

var MOCK_USER_PROPERTY = 'GA_AUDIT_MOCK_USER_EMAIL';

var Auth = {
  _cachedUser: undefined,

  /**
   * Workspace 로그인 이메일 확보.
   *
   * 반드시 getActiveUser() 만 사용한다.
   * 배포 설정이 "실행 주체 = 나(USER_DEPLOYING)" 인 경우 getEffectiveUser() 는
   * 접속자가 아니라 배포자를 가리키므로, 이를 fallback 으로 쓰면
   * 모든 접속자가 배포자로 인식되는 심각한 권한 문제가 발생한다.
   * 값이 비면 오류로 처리하고 배포 설정을 점검하도록 안내한다.
   */
  resolveEmail: function () {
    try {
      return Util.trim(Session.getActiveUser().getEmail()).toLowerCase();
    } catch (err) {
      return '';
    }
  },

  /** PoC 데모용 계정 (production 설정에서는 ALLOW_MOCK_USER=false 로 완전 차단) */
  mockEmail: function () {
    if (!Config.bool('ALLOW_MOCK_USER')) return '';
    try {
      return Util.trim(
        PropertiesService.getUserProperties().getProperty(MOCK_USER_PROPERTY)
      ).toLowerCase();
    } catch (err) {
      return '';
    }
  },

  /**
   * 현재 사용자.
   * @return {{email: string, name: string, department: string, isAdmin: boolean, isMockSession: boolean}}
   */
  getCurrentUser: function () {
    if (this._cachedUser !== undefined) return this._cachedUser;

    var mock = this.mockEmail();
    var email = mock || this.resolveEmail();

    if (!email) {
      this._cachedUser = null;
      return null;
    }

    var profile = Repository.findUserByEmail(email);
    var user = {
      email: email,
      name: (profile && profile.name) || email.split('@')[0],
      department: (profile && profile.department) || '',
      isAdmin: this.isAdminEmail(email),
      isMockSession: !!mock
    };
    this._cachedUser = user;
    return user;
  },

  /** 로그인 필수 구간에서 사용 */
  requireUser: function () {
    var user = this.getCurrentUser();
    if (!user) {
      throw new AppError(
        'NOT_SIGNED_IN',
        ERROR_MESSAGES.NOT_SIGNED_IN,
        'Session.getActiveUser().getEmail() 이 비어 있습니다. ' +
          '웹 앱 배포 설정(실행 주체=사용자, 액세스=도메인 내 사용자)을 확인하세요.'
      );
    }
    return user;
  },

  requireAdmin: function () {
    var user = this.requireUser();
    if (!user.isAdmin) {
      throw new AppError('FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, user.email);
    }
    return user;
  },

  isAdminEmail: function (email) {
    var normalized = Util.trim(email).toLowerCase();
    if (!normalized) return false;
    if (Config.adminEmails().indexOf(normalized) >= 0) return true;
    var admins = Repository.listAdmins();
    for (var i = 0; i < admins.length; i++) {
      if (Util.trim(admins[i].email).toLowerCase() === normalized) return true;
    }
    return false;
  },

  /* ---------------- PoC 데모 계정 전환 ---------------- */

  /** 데모 계정 목록 (ALLOW_MOCK_USER=false 이면 빈 배열) */
  listMockUsers: function () {
    if (!Config.bool('ALLOW_MOCK_USER')) return [];
    return Repository.listUsers().map(function (u) {
      return {
        email: u.email,
        name: u.name,
        department: u.department,
        isAdmin: Auth.isAdminEmail(u.email)
      };
    });
  },

  /**
   * 데모 계정으로 전환.
   * 선택 결과는 서버측 UserProperties 에 기록되므로,
   * 이후 요청에서도 신원은 서버가 판단한다. (클라이언트가 매번 신원을 주장하지 않는다)
   */
  signInAsMockUser: function (email) {
    if (!Config.bool('ALLOW_MOCK_USER')) {
      throw new AppError('FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, 'mock user disabled');
    }
    var normalized = Util.trim(email).toLowerCase();
    var allowed = Repository.listUsers().filter(function (u) {
      return Util.trim(u.email).toLowerCase() === normalized;
    });
    if (!allowed.length) {
      throw new AppError('FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, 'unknown demo user');
    }
    PropertiesService.getUserProperties().setProperty(MOCK_USER_PROPERTY, normalized);
    this._cachedUser = undefined;
    return this.getCurrentUser();
  },

  signOutMockUser: function () {
    try {
      PropertiesService.getUserProperties().deleteProperty(MOCK_USER_PROPERTY);
    } catch (err) {
      // noop
    }
    this._cachedUser = undefined;
  },

  /** 요청 단위 캐시 초기화 (테스트용) */
  reset: function () {
    this._cachedUser = undefined;
  }
};
