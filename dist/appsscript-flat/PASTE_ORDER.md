# Apps Script 편집기에 붙여넣는 순서

파일명은 아래와 **똑같이** 만들어야 합니다 (확장자 제외한 이름이 일치해야 include 가 동작).

## 스크립트 파일 (.gs)

1. `config`
2. `util`
3. `auth`
4. `repository`
5. `mockRepository`
6. `sheetRepository`
7. `mockStorage`
8. `driveService`
9. `assetService`
10. `auditService`
11. `adminService`
12. `setup`
13. `main`

## HTML 파일

- `admin`
- `app`
- `components`
- `index`
- `qr`
- `scripts`
- `styles`
- `vendor_jsqr`

## 매니페스트

`appsscript.json` 은 편집기 좌측 하단 **프로젝트 설정 → "appsscript.json" 매니페스트 파일 표시**를
켠 뒤 내용을 교체합니다.

생성 시각: 2026-09-08T00:38:20.133Z
