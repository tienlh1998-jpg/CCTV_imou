# UI CONTRACT — CCTV Vision Hub v2.0

**Owner:** Foundation UI (B)
**Đối tượng:** các view agent C1–C7 và agent integration.
**Nguồn chuẩn:** `docs/UI_REBUILD_SPEC.md` (§4, §6, §7, §9). Khi tài liệu này khác đặc tả, đặc tả thắng; hãy báo lại Foundation/Product thay vì tự đổi hợp đồng.

Tài liệu này mô tả **đúng những gì `static/js/core.js` đang cung cấp** sau khi Foundation hoàn tất, để view agent không phải đọc toàn bộ core.

---

## 1. Nguyên tắc bất biến

1. Mọi dữ liệu động render bằng `textContent` / `CCTV.dom.el({text})`. **Cấm** `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`.
2. **Cấm** inline `<script>`, `<style>`, thuộc tính `on*`, thuộc tính `style="..."`, `javascript:`. Nếu cần thanh tiến trình, dùng `element.style.setProperty('--pct', '42%')`.
3. Không thêm CDN, font/ảnh ngoài, dependency, `<script src>` ngoài các file đã khai báo trong `templates/index.html`.
4. Không lưu mật khẩu, CSRF, session, role, token vào `localStorage`/`sessionStorage`/URL/DOM. Allowlist UI duy nhất: `cctv.ui.sidebarCollapsed`, `cctv.ui.grid`, `cctv.ui.pageSize`, `cctv.ui.ptzPresets` (chỉ nhãn preset).
5. Không gửi mật khẩu camera cho stream/audio/snapshot/PTZ/record/details/hardware/storage. Server tự resolve credential. Chỉ gửi password trong body của:
   - `POST /api/auth/login`
   - `POST /api/auth/change_password`
   - `POST /api/cameras/credentials`
   - `POST/PUT /api/managed/cameras`
   - `POST /api/managed/cameras/test`
   - `POST /api/batch_change_password`
   - fallback optional của `POST /api/batch-ip`, `/api/reboot`, `/api/sync-time` (admin, write-only)
6. Server là nguồn quyết định quyền. View chỉ ẩn nút. Mọi thao tác admin vẫn phải chịu 403 từ server.
7. Không tự động quét mạng, không tự gọi hành động nguy hiểm khi mount view.
8. Không dùng `setInterval`/`setTimeout` lặp; dùng `CCTV.poll`. Timeout một lần cho animation/UX được phép, phải clear trong `destroy`.
9. Không render số liệu giả. API lỗi → error panel/empty state, giữ dữ liệu cũ nếu có.

---

## 2. Namespace

```js
window.CCTV = {
  version: '2.0.0',
  apiVersion: 2,
  dom, fmt, api, auth, state, router, views, ui, media, icons, poll
};
```

Ngoài `window.CCTV` không được tạo biến toàn cục. Mỗi file view là một IIFE `'use strict'`, mở đầu:

```js
(function () {
  'use strict';
  if (!window.CCTV || !window.CCTV.views) { return; }
  // ...
  CCTV.views.register('cameras', { /* meta */ });
})();
```

---

## 3. `CCTV.dom`

```ts
CCTV.dom.el(tag, {
  class?: string | string[],
  text?: string,
  attrs?: Record<string, string|number|boolean>,
  dataset?: Record<string, string|number>,
  on?: Record<string, (ev) => void>,
  children?: Node[] | Node | string
}) -> HTMLElement
```

- `html` **bị chặn** (ném lỗi).
- `attrs` chặn `on*`, `style`, `srcdoc`, `formaction`, `http-equiv`.
- `href` chỉ nhận `#...`, `/...`, `blob:...`, hoặc http(s) cùng origin.
- `src` chỉ nhận `/...`, `blob:...`, `data:image/...`.
- `target="_blank"` tự thêm `rel="noopener noreferrer"`.
- Thuộc tính boolean (`disabled`, `checked`, `required`, `readonly`, `selected`) nhận `true`; `value` được gán bằng property.

```ts
CCTV.dom.text(node, value)      // textContent
CCTV.dom.clear(node)
CCTV.dom.fragment(children) -> DocumentFragment
CCTV.dom.svg(name, {size?, label?, class?}) -> SVGElement  // <use href="#i-...">
CCTV.dom.safePath(url) -> string | null   // chỉ path cùng origin, chặn //, \, control chars
CCTV.dom.append(node, children)
```

Icon hợp lệ nằm trong sprite của `templates/index.html` (xem Phụ lục A đặc tả). Nếu icon không tồn tại, dùng `circle` và báo Foundation.

---

## 4. `CCTV.fmt`

```ts
fmt.dateTime(v) -> 'HH:mm:ss DD/MM/YYYY'
fmt.date(v) -> 'DD/MM/YYYY'
fmt.time(v) -> 'HH:mm:ss'
fmt.relative(v) -> 'vừa xong' | 'N phút trước' | ...
fmt.bytes(n) -> '1,24 GB'
fmt.duration(sec) -> '1 giờ 02 phút' | '5 phút 03 giây'
fmt.number(n) -> '1.234,5'
fmt.percent(n) -> '42,5%'
fmt.status(v) -> {key, label, tone, icon, css}
fmt.errorCode(code) -> 'FFMPEG_UNAVAILABLE — FFmpeg chưa được cài...'
```

- Nhận `YYYY-MM-DD HH:mm:ss`, ISO 8601, epoch giây/ms, `Date`. Không parse được → trả chuỗi gốc (hoặc `—`).
- Múi giờ hiển thị: `Asia/Ho_Chi_Minh`.
- `fmt.status` hỗ trợ tối thiểu: `online`, `offline`, `auth_failed`, `solar_sleep`, `unknown`, `sent`, `failed`, `skipped`, `suppressed`, `recording`, `armed`, `disarmed`, `ok`, `no_sd`, `storage_error`.

---

## 5. `CCTV.api`

```ts
CCTV.api.request(method, path, opts?) -> Promise<any>
CCTV.api.get(path, opts?)
CCTV.api.post(path, body?, opts?)
CCTV.api.put(path, body?, opts?)
CCTV.api.del(path, body?, opts?)
CCTV.api.getBlob(path, opts?) -> Promise<{blob, headers, status, filename}>
CCTV.api.download(path, filename?, opts?) -> Promise<void>
```

`opts`:

| Khóa | Ý nghĩa |
|---|---|
| `body` | Object JSON. POST/PUT/DELETE luôn gửi body (mặc định `{}`). |
| `query` | `Record<string, string|number|boolean|array>`; giá trị `undefined/null` bị bỏ. |
| `signal` | `AbortSignal` (luôn truyền `ctx.signal`). |
| `timeoutMs` | Mặc định 20000; scan nên 120000. |
| `expect` | `'json'` (mặc định) \| `'blob'` \| `'text'`. |
| `meta` | Với blob: trả kèm headers/status/filename. |
| `silent` | `true` = core không tự toast lỗi; view tự hiển thị. |
| `skipAuthRedirect` | Chỉ dùng nội bộ cho `/api/auth/*`. View thường không cần. |
| `headers` | Header bổ sung; **không** tự set CSRF. |

Hành vi của core:

- `credentials: 'same-origin'`, `cache: 'no-store'`, `referrerPolicy: 'no-referrer'`.
- Tự gắn `X-CSRF-Token` cho mọi POST/PUT/PATCH/DELETE nếu đã có CSRF.
- Chỉ nhận path tương đối bắt đầu bằng `/`; chặn URL tuyệt đối/`//host`.
- GET lỗi mạng (không phải 4xx/5xx) được retry **1 lần**; POST không retry.
- `401` → `CCTV.auth.handleUnauthenticated()` (trừ `skipAuthRedirect`), hiện login.
- `403` → toast “Bạn không có quyền…” (trừ `silent`).
- `429` → toast kèm thời gian chờ (trừ `silent`).
- `503` → toast kèm `code` (ví dụ `FFMPEG_UNAVAILABLE`) (trừ `silent`).
- `5xx`/lỗi mạng → toast lỗi (trừ `silent`).
- Lỗi luôn ném `CCTV.api.ApiError`; view phải `.catch`.

`ApiError`:

```js
{
  name: 'ApiError',
  status: number,        // HTTP status hoặc 0 cho lỗi mạng/timeout/abort
  code: string,          // 'FORBIDDEN', 'CAMERA_CREDENTIAL_REQUIRED', ...
  message: string,       // tiếng Việt từ server hoặc map mặc định
  details: object|null,
  requestId: string|null,
  retryAfterSeconds: number|null
}
```

- `code === 'ABORTED'` khi view bị rời/unmount hoặc gọi bị huỷ → **im lặng**.
- HTTP 2xx nhưng `{ok:false}` cũng ném ApiError.
- Không hiển thị `details` thô nếu có thể chứa dữ liệu nội bộ; chỉ dùng field đã biết.

Quy ước UI lỗi:

| HTTP | Cách hiển thị |
|---|---|
| 400 | Lỗi cạnh field (nếu form) hoặc error panel; không toast chung. |
| 401 | Core tự về login; không toast riêng. |
| 403 | Toast của core là đủ; không toast lặp. |
| 404 | Empty/error panel theo ngữ cảnh. |
| 409 | Xử lý theo `code`: `CAMERA_CREDENTIAL_REQUIRED` mở modal credential (admin), `ALREADY_RECORDING` chuyển trạng thái ghi, `SCAN_IN_PROGRESS` thông báo. |
| 429 | Toast core + disable nút tạm nếu cần. |
| 502 | Toast/error panel, giữ form để thử lại. |
| 503 | Banner/toast theo `code`; không auto-retry. |

Ví dụ:

```js
ctx.api.get('/api/managed/cameras', { signal: ctx.signal })
  .then(data => render(data.cameras))
  .catch(err => {
    if (err.code === 'ABORTED') return;
    showError(err);
  });
```

---

## 6. `CCTV.auth`

```ts
auth.init() -> Promise<{authenticated, role, error?}>
auth.me(options?) -> Promise<Session|null>
auth.login(role: 'admin'|'viewer', password: string) -> Promise<Session>
auth.logout() -> Promise<boolean>
auth.changePassword({target, currentPassword, newPassword, clearViewer?}) -> Promise<any>
auth.role() -> 'admin'|'viewer'|null
auth.isAdmin() -> boolean
auth.csrf() -> string|null      // chỉ đọc; không lưu ở nơi khác
auth.session() -> {role, username, displayName, expiresAt}|null
auth.info() -> {firstRun, viewerLoginEnabled, appVersion, apiVersion, loaded}
auth.onChange(fn) -> unsubscribe
auth.handleUnauthenticated(reason?)   // idempotent, chỉ core gọi
auth.setUnauthenticatedHandler(fn)    // core boot dùng; view không gọi
auth.startRevalidation(ms?) -> stop
auth.purgeLegacyStorage()
```

- CSRF và session nằm trong closure của core; **không** có API ghi.
- Không có API lấy mật khẩu; không lưu mật khẩu.
- `login` nhận **role** (`'admin'`/`'viewer'`) và map sang username tương ứng.
- `changePassword` thành công sẽ tự đưa về login (server thu hồi mọi session).
- View có thể dùng `auth.session()` để hiển thị hạn phiên; không tự gia hạn.

---

## 7. `CCTV.state`

```ts
state.get(key) -> any
state.set(key, value)
state.patch(key, partialObject)
state.subscribe(key, fn) -> unsubscribe
state.reset()
state.refresh(key) -> Promise<any>   // dedupe theo key
state.getUi(key, fallback)
state.setUi(key, value)
```

Khóa dữ liệu:

| Khóa | Shape | Ghi chú |
|---|---|---|
| `session` | `{role, username, expiresAt}` | core tự cập nhật. |
| `health` | object `/api/health` | dedupe. |
| `systemStatus` | object `/api/system/status` | dedupe; dashboard dùng. |
| `cameras` | `ManagedCamera[]` | dedupe; **không password**. |
| `scan` | `{devices, scannedAt, targets}` | do scanner view set; không persist. |
| `alarms` | `{history: AlarmHistoryItem[]}` | tùy chọn dùng. |
| `settings` | object an toàn | admin; dedupe. |
| `alarmStatus` | object `/api/alarm/status` | **bổ sung của Foundation**; core poll 30s cho topbar. |

`state.refresh` chỉ có loader cho: `health`, `systemStatus`, `cameras`, `alarmStatus`, `settings`. `settings` trả `null` với viewer và không gọi API.

UI persistence (allowlist):

| Key | Giá trị | Ghi chú |
|---|---|---|
| `sidebarCollapsed` | boolean | core tự lưu. |
| `grid` | `{mode: '1'|'2x2'|'3x3', slots: (null|{ip, channel})[]}` | **Mảng slot giữ nguyên vị trí, có thể chứa `null`**, tối đa 1/4/9 phần tử. Do live view sở hữu. |
| `pageSize` | 10/15/20/30/50 | |
| `ptzPresets` | `{ [ip]: { "1".."8": "nhãn" } }` | chỉ nhãn ≤32 ký tự, do live view sở hữu. |

`state.reset()` không xoá `cctv.ui.*`.

---

## 8. `CCTV.views` và `CCTV.router`

### 8.1 Đăng ký

```ts
CCTV.views.register(name, {
  title: string,                    // tiêu đề sidebar/topbar
  icon: string,                     // tên symbol: dashboard, live, cameras, scanner, storage, alarms, settings
  roles: ('admin'|'viewer')[],
  order: number,                    // 10,20,...70
  render(container: HTMLElement, ctx: ViewContext): void | Promise<void>,
  destroy?(): void,
  onResume?(): void
});
```

- Không được đăng ký trùng tên; core sẽ throw.
- View agent **giữ nguyên** `name`, `title`, `icon`, `roles`, `order` của stub.
- `render` phải dựng skeleton/khung **đồng bộ** trước khi await.
- `destroy` phải idempotent và dọn: poll, media, audio, interval/timeout, listener `window`/`document`, modal/drawer do view mở.
- Router đã abort `ctx.signal` khi rời view và gọi `destroy()`.

### 8.2 `ViewContext`

```ts
{
  role: 'admin'|'viewer',
  isAdmin: boolean,
  signal: AbortSignal,
  api: CCTV.api,
  ui: CCTV.ui,
  state: CCTV.state,
  router: CCTV.router,
  container: HTMLElement,
  toast: CCTV.ui.toast,
  confirm: CCTV.ui.confirm,
  format: CCTV.fmt,
  icons: CCTV.icons
}
```

### 8.3 Router

```ts
router.init({defaultView?})
router.start()
router.stop()
router.go(name, {replace?})
router.current() -> name|null
router.onChange(fn) -> unsubscribe
router.routes() -> {name,title,icon}[]   // đã lọc theo role
```

- Hash-based, không đọc query string ngoài hash. Không deep-link debug.
- Viewer vào `#/scanner` hoặc `#/settings` → `#/dashboard` + toast.
- Không tự đổi `location.hash`; dùng `router.go`.
- `document.title` và topbar do router cập nhật.
- `Alt+1..7` do core xử lý theo danh sách route được phép; `/` focus ô `[data-view-search]`; `Escape` đóng menu/sidebar/lớp phủ.

---

## 9. `CCTV.ui`

Tất cả trả về `HTMLElement`/handle; **không trả chuỗi HTML**.

```ts
ui.button({label?, variant?: 'primary'|'secondary'|'ghost'|'danger', icon?, onClick?,
           disabled?, ariaLabel?, title?, size?: 'sm', block?, testId?, iconSize?}) -> HTMLButtonElement
ui.iconButton({icon, label, onClick, variant?, size?, testId?}) -> HTMLButtonElement
ui.badge(text, {tone?: 'neutral'|'success'|'warning'|'danger'|'info'|'primary'}) -> HTMLElement
ui.statusPill(status, {label?, title?}) -> HTMLElement
ui.kpi({label, value, hint?, icon?, tone?, testId?}) -> HTMLElement
ui.banner({tone, title, message?, actions?: Node[], dismissible?, icon?, testId?}) -> HTMLElement
ui.progress({value, max, label?, tone?, ariaLabel?, valueText?}) -> {el, setValue(v,max?)}
ui.gauge({percent, label?, valueText?, tone?}) -> HTMLElement
ui.tabs({tabs:[{id,label,icon?,badge?,badgeTone?}], active, onChange, label?, testId?})
   -> {el, setActive(id, focus?), getActive(), getPanelId(id), getTabId(id), destroy()}
ui.switch({checked, label, description?, onChange, disabled?, testId?})
   -> {el, isChecked(), setChecked(v), setDisabled(v), input}
ui.field({label, name?, type?, value?, options?, placeholder?, help?, required?, disabled?,
          autocomplete?, maxlength?, min?, max?, step?, mono?, testId?})
   -> {el, input, getValue(), setValue(v), setError(msg), clearError(), setDisabled(v), setOptions(opts,val), focus()}
ui.search({placeholder?, ariaLabel?, onInput(value), testId?})
   -> {el, input, getValue(), clear(), focus(), destroy()}
ui.toolbar({left?: Node|Node[], right?: Node|Node[]}) -> HTMLElement
ui.pageHeader({title, subtitle?, icon?, actions?: Node[], testId?}) -> HTMLElement  // có <h1>
ui.pagination({page, pageSize, total, onChange(page,pageSize,sizeChanged), pageSizes?})
   -> {el, setState({page?,pageSize?,total?}), getState()}
ui.skeleton({variant?: 'text'|'card'|'table'|'kpi', rows?}) -> HTMLElement
ui.empty({icon?, title, description?, action?: Node|Node[]}) -> HTMLElement
ui.errorPanel({title, message?, code?, requestId?, retry?}) -> HTMLElement
ui.table(options) -> {el, update({rows?,loading?,selectedKeys?,sort?}), getSelection(), destroy()}
ui.modal({title, subtitle?, body: Node|string, footer?: Node|Node[], size?: 'sm'|'md'|'lg'|'xl',
          dismissible?, initialFocus?, dirtyCheck?, onClose?, role?, descriptionId?, restoreFocus?})
   -> {el, layer, body, close(), requestClose(), setBusy(bool), setError(msg?)}
ui.drawer({title, body, footer?, wide?, dismissible?, dirtyCheck?, onClose?}) -> same handle
ui.confirm({title, message?, details?: Node|string, confirmLabel?, cancelLabel?,
            variant?: 'primary'|'danger', requireText?, requireTextLabel?}) -> Promise<boolean>
ui.toast(message, {type?: 'success'|'error'|'warning'|'info', duration?, silent?}) -> {close()}
ui.copy(text, {label?, silent?}) -> Promise<boolean>
ui.downloadBlob(blob, filename)
ui.openExternal(url) -> Promise<boolean>
ui.applyRole(root, role)
ui.busy(button, busy, label?)
ui.debounce(fn, waitMs) -> wrapped  // wrapped.cancel(), wrapped.flush()
```

Chi tiết quan trọng:

- `ui.table` dùng `render(row) -> Node | string`; string được set bằng `textContent`.
- `ui.table` có sẵn sort client-side nếu không truyền `onSort`; checkbox header chọn toàn bộ dòng hiện có; `emptyNode` tùy chọn; `mobile:'cards'` cho bảng chính.
- `ui.modal`/`ui.drawer`: focus trap, `Escape` đóng nếu `dismissible`, `dirtyCheck` → confirm “Bỏ thay đổi?”, restore focus. **Không** dùng `alert()`/`confirm()` native.
- `ui.confirm` dùng `role="alertdialog"`, focus mặc định vào nút Huỷ; `requireText` phải khớp chính xác sau `trim()`.
- `ui.toast`: tối đa 3, `error` dùng `role="alert"` và 8s; không chứa dữ liệu nhạy cảm.
- `ui.openExternal` là **async** (khác chữ ký gốc trong đặc tả) vì cần confirm mixed-content; chỉ mở HTTP(S) tới IPv4 private/loopback, chặn `user:pass@`.
- `ui.applyRole` **ẩn** (`hidden=true`) các phần tử `[data-admin-only]` với viewer, không xoá, để có thể đăng nhập lại vai trò khác trong cùng trang. Tuy vậy, view vẫn phải không render nút admin khi `ctx.isAdmin === false`.
- Không dùng `ui.busy` cho nút icon-only nếu không có `.c-btn__label`; khi đó tự set `disabled` + `aria-busy`.

### 9.1 Component CSS

Class gốc (Foundation sở hữu):

| Nhóm | Class |
|---|---|
| Shell | `.c-shell`, `.c-sidebar`, `.c-topbar`, `.c-view`, `.c-bottom-nav` |
| Bố cục | `.c-stack`, `.c-grid`, `.c-grid--kpi`, `.c-grid--2`, `.c-grid--3`, `.c-grid--sidebar`, `.c-row`, `.c-divider` |
| Card/KPI | `.c-card`, `.c-card__header/body/footer`, `.c-kpi` |
| Trạng thái | `.c-badge`, `.c-status`, `.c-dot`, `.c-chip`, `.c-banner` |
| Bảng | `.c-table-wrap`, `.c-table`, `.c-table--cards` |
| Điều khiển | `.c-btn`, `.c-input`, `.c-select`, `.c-textarea`, `.c-switch`, `.c-segment`, `.c-check`, `.c-field` |
| Lớp phủ | `.c-modal-layer`, `.c-modal`, `.c-drawer-layer`, `.c-drawer`, `.c-toast-stack`, `.c-toast` |
| Khác | `.c-tabs`, `.c-tab`, `.c-pagination`, `.c-skeleton`, `.c-empty`, `.c-error-panel`, `.c-progress`, `.c-gauge`, `.c-menu`, `.c-tooltip` |
| Live (Foundation đã cung cấp) | `.c-live`, `.c-live__toolbar`, `.c-live__layout`, `.c-live__grid`, `.c-video-tile`, `.c-ptz` |
| Dashboard | `.c-dash-grid`, `.c-banner-list`, `.c-alert-list`, `.c-health-list`, `.c-camera-mini` |

- Không hardcode mã màu; dùng token `:root` (`--bg`, `--surface`, `--text-muted`, `--primary`, `--danger`, ...).
- View có thể thêm class riêng với tiền tố `.view-<name>` nhưng **hiện chưa có link CSS riêng** trong `index.html`. Muốn thêm file `static/css/views/<name>.css` phải do Foundation thêm `<link>`; không được tự chèn `<style>`.
- Spacing 4px grid; radius `--radius-md/lg`; focus `:focus-visible`.
- `prefers-reduced-motion` đã được xử lý toàn cục.

---

## 10. `CCTV.media`

```ts
media.mjpeg(img, {
  ip, subtype?: '0'|'1', channel?: 1|2,
  onState?: (state: 'connecting'|'live'|'error'|'credential-required'|'unavailable', info) => void
}) -> {stop(), restart(), setQuality('0'|'1'), setChannel(1|2), getChannel(), getQuality()}

media.audio({ip, subtype?, channel?}) -> {el: HTMLAudioElement, play(): Promise<void>, stop()}

media.snapshot(ip, {subtype?, channel?, download?, silent?, signal?})
  -> Promise<{blob, url, filename}>

media.probe(ip, {subtype?, channel?, signal?})
  -> Promise<{status, code, message, retryAfterSeconds, blob?, url?, filename?}>

media.revoke(url)
```

- URL media chỉ chứa `ip`, `subtype`, `channel`, `_`; **không password**.
- `mjpeg` tự:
  - backoff 1/2/4/8/15s, tối đa 5 lần;
  - khi lỗi gọi snapshot để phân biệt 401/403/409/503;
  - `409` → `credential-required`; `503 FFMPEG_UNAVAILABLE` → `unavailable`; 401 core tự về login; 403/404 → `error` fatal.
- `media.snapshot` tự tải file nếu `download !== false`; nếu `download:false`, caller phải `media.revoke(url)`.
- `media.probe` không ném lỗi; trả status/code.
- Audio chỉ phát sau user gesture; view phải dừng khi đổi camera/rời view.
- View **phải** dừng mọi media trong `destroy`: `ctl.stop()` cho từng tile, `audio.stop()`, thu hồi blob URL nếu tự tạo.

---

## 11. `CCTV.poll`

```ts
CCTV.poll(fn, {
  intervalMs: number,        // mặc định 15000
  immediate?: boolean,       // mặc định true
  maxBackoffMs?: number,     // mặc định 60000
  pauseWhenHidden?: boolean  // mặc định true
}) -> stop()
```

- `fn(signal)` được gọi tuần tự, không overlap; lỗi → backoff nhân đôi.
- Tự dừng khi `document.hidden` (nếu bật), chạy lại ngay khi tab hiện.
- `stop()` idempotent. View phải gọi trong `destroy`.
- Không truyền `fn` trả Promise rejection chưa bắt; poll đã bắt rejection.

---

## 12. `CCTV.icons`

```ts
CCTV.icons.svg(name, {size?, label?, class?}) -> SVGElement
CCTV.icons.exists(name) -> boolean
```

`label` có → `role="img"` + `aria-label`; không có → `aria-hidden="true"`.

---

## 13. Vai trò và UI

| Thành phần | Admin | Viewer |
|---|---|---|
| Nav `Quét mạng`, `Cài đặt` | Có | Không (router chặn) |
| Dashboard quick actions | Có | Không |
| Camera add/edit/delete/batch/sync | Có | Không |
| Switch gác từng camera | Có | Chỉ badge |
| Rename/reboot/privacy/tracking/siren | Có | Không |
| Live PTZ/record/external player | Có | Không |
| Live audio/snapshot/grid/quality/lens | Có | Có |
| Storage format/open folder | Có | Không |
| Alarms arm/disarm/test/clear/watchdog | Có | Không |
| Alarms history/snapshot | Có | Có |
| PWA / APK | Có | Có |

Cách làm đúng:

```js
if (ctx.isAdmin) {
  root.appendChild(ui.button({label: 'Thêm camera', icon: 'plus', variant: 'primary'}));
}
```

- Không render rồi ẩn bằng CSS.
- `data-admin-only="1"` là lớp bảo hiểm, không phải cơ chế chính.
- Trước hành động nguy hiểm dùng `ctx.confirm` với `requireText` khi đặc tả yêu cầu:
  - Format thẻ: `FORMAT`
  - Đổi IP hàng loạt: `DOI-IP`
  - Đổi mật khẩu camera hàng loạt: `DOI-MAT-KHAU`
  - Reboot: `REBOOT`
  - Khôi phục mặc định: `RESET`
  - Bật còi: confirm thường; tắt gác: confirm thường.
- Không hiển thị lại mật khẩu mới sau khi submit.

---

## 14. API theo view (tóm tắt)

Shape chi tiết: `docs/UI_REBUILD_SPEC.md` §6. Không tự thêm endpoint.

### Dashboard (`#/dashboard`)

- `GET /api/system/status` (viewer)
- `GET /api/alarm/history?limit=5` (viewer)
- `GET /api/managed/cameras` (viewer)
- `GET /api/alarm/status` (viewer)
- `GET /api/health` (public)
- `POST /api/alarm/toggle` (admin, `{armed, confirm?}`)

### Live (`#/live`)

- `GET /api/managed/cameras`
- `GET /api/stream/mjpeg?ip=&subtype=&channel=&_=`
- `GET /api/stream/audio?...`
- `GET /api/snapshot?ip=&subtype=&channel=`
- `POST /api/record/start|stop`, `GET /api/record/status` (record: admin)
- `POST /api/ptz` (admin)
- `POST /api/stream/open` (admin; **không** gửi `rtsp_url`)
- `GET /api/hardware/status?ip=` (badge privacy/tracking/siren)
- `POST /api/cameras/credentials` (admin; mật khẩu transient)
- `GET /api/recordings/<filename>` qua `api.download`

### Camera (`#/cameras`)

- `GET/POST /api/managed/cameras`, `PUT/DELETE /api/managed/cameras/<id>`
- `POST /api/managed/cameras/test|sync|toggle-alarm`
- `GET /api/camera/details?ip=`, `POST /api/camera/name`
- `GET /api/hardware/status`, `POST /api/hardware/privacy|tracking|siren`
- `GET /api/storage/info`, `GET /api/storage/recordings`
- Batch: `POST /api/batch-ip`, `/api/reboot`, `/api/sync-time`, `/api/batch_change_password`

### Scanner (`#/scanner`, admin)

- `GET /api/scan?subnet=&deep=`, `GET /api/scan/vlans`
- `POST /api/managed/cameras` (batch `{batch:[...], default_password}`)
- `POST /api/batch-ip`, `/api/reboot`, `/api/sync-time`, `/api/batch_change_password`
- `GET /api/export` qua `api.download`; **không** `window.location.href`

### Storage (`#/storage`)

- `GET /api/storage/info?ip=`
- `POST /api/storage/format` (`{ip, confirm:'FORMAT'}`, admin)
- `GET /api/storage/recordings?ip=&date=`
- `GET /api/record/status`, `GET /api/recordings/<filename>`
- `POST /api/settings/open-folder` (admin)

### Alarms (`#/alarms`)

- `GET /api/alarm/status`, `GET /api/alarm/history?limit=&offset=&ip=&date=&status=`
- `POST /api/alarm/toggle|test|clear_history` (admin)
- `POST /api/storage/watchdog/check_now` (admin)
- `GET/POST /api/settings` (admin; chỉ cần phần Telegram/schedule/armed cameras)
- Ảnh cảnh báo: dùng `dom.safePath(item.snapshot_url)` trước khi gán `img.src`.

### Settings (`#/settings`, admin)

- `GET/POST /api/settings`, `POST /api/settings/open-folder`
- `POST /api/auth/change_password`
- `GET /api/scan/vlans`, `GET /api/health`, `GET /api/system/status`
- Không hiển thị/không gửi lại secret; `secrets.*_set` chỉ là cờ.

---

## 15. Test ID bắt buộc

Foundation đã gắn test ID cho shell/login/menu:

- Login: `login-form`, `login-role-admin`, `login-role-viewer`, `login-password`, `login-submit`, `login-error`
- Shell: `app-shell` (id), `sidebar` (id), `topbar` (id), `nav-<name>` (core tạo), `user-menu`, `logout-btn`

View agent phải giữ đúng các ID trong §2.9 đặc tả:

| View | Test ID |
|---|---|
| Dashboard | `dashboard-kpi-cameras`, `dashboard-kpi-online`, `dashboard-kpi-offline`, `dashboard-kpi-armed`, `dashboard-kpi-alerts`, `dashboard-banner-ffmpeg`, `dashboard-banner-password`, `dashboard-recent-alerts`, `dashboard-quick-actions` |
| Live | `live-camera-select`, `live-quality`, `live-lens`, `live-grid-1`, `live-grid-2x2`, `live-grid-3x3`, `live-snapshot-btn`, `live-audio-btn`, `live-record-btn`, `live-ptz-panel`, `live-external-player`, `live-tile` |
| Live (bổ sung Foundation) | `live-camera-filter` |
| Camera | `cameras-table`, `cameras-search`, `cameras-add-btn`, `cameras-detail-drawer`, `cameras-batch-bar`, `cameras-sync-health`, `cameras-tab-info/network/hardware/storage` |
| Scanner | `scanner-subnet`, `scanner-deep`, `scanner-detect-vlans`, `scanner-start-btn`, `scanner-cancel-btn`, `scanner-results`, `scanner-batch-add`, `scanner-export` |
| Storage | `storage-camera-select`, `storage-sd-card`, `storage-format-btn`, `storage-date`, `storage-clips-table`, `storage-open-folder` |
| Alarms | `alarms-arm-switch`, `alarms-test-telegram`, `alarms-history-table`, `alarms-clear-history`, `alarms-watchdog`, `alarms-run-watchdog` |
| Settings | `settings-tab-account/scan/storage/telegram/system/about`, `settings-change-password`, `settings-viewer-password`, `settings-save` |

---

## 16. Trạng thái tạm thời / sai lệch cần biết

1. **Trạng thái view:** cả 7 view (`dashboard`, `live`, `cameras`, `scanner`, `storage`, `alarms`, `settings`) đã được triển khai, giữ nguyên meta đăng ký (`name/title/icon/roles/order`).
2. **Chưa có file CSS riêng cho view.** Dùng component/class của Foundation. Nếu cần CSS mới, đề nghị Foundation thêm `<link>` + file; không tự chèn style.
3. **Không có `static/offline.html`** trong phạm vi Foundation này. Service worker trả plain-text 503 khi offline; navigation là network-only.
4. **PTZ API không hỗ trợ chéo thật.** Server chỉ có 4 lệnh liên tục (`Up/Down/Left/Right`) và 4 lệnh bước (`StepUp/StepDown/StepLeft/StepRight`). Live view trình bày D-pad 4 hướng + hàng “bước nhỏ” 4 nút; đây là giới hạn backend, không phải thiếu UI.
5. **`ui.openExternal` trả Promise** (confirm mixed-content) thay vì boolean đồng bộ.
6. **Grid lưu `slots` có phần tử `null`** để giữ vị trí ô.
7. **`CCTV.api.getBlob`** là helper bổ sung (dùng cho snapshot/probe).
8. **`CCTV.state` có thêm khóa `alarmStatus`** cho topbar; không thay đổi các khóa đặc tả.
9. **`auth.login(role, password)`** (role là `'admin'`/`'viewer'`), không phải `login(password)`.
10. **Backend phải đang ở nhánh `/api/auth/*` + `/api/health` + `/api/system/status`.** Nếu server cũ chưa có, login sẽ báo không kết nối được.
11. Login screen gọi `/api/health` trước đăng nhập; đây là endpoint public theo đặc tả.
12. **MIME tĩnh — đã sửa ở bước tích hợp:** `_file_response` trong `app.py` nay map MIME theo phần mở rộng (`.css → text/css`, `.js → application/javascript`, ảnh/font tương ứng) trước khi gọi `bottle.static_file`, nên CSS/JS không còn bị `nosniff` chặn. `tests/ui_smoke.py` có check hồi quy MIME; asset trong `index.html`/`sw.js` được nâng query version `?v=2.0.1` để buộc trình duyệt bỏ cache header `text/html` cũ. E2E trên test mode 127.0.0.1:18080 đã xác nhận `window.CCTV` load và CSS áp dụng.

---

## 17. Checklist trước khi gửi view

- [ ] `node --check static/js/views/<name>.js` pass.
- [ ] `render` dựng khung đồng bộ, có skeleton/empty/error.
- [ ] Mọi fetch qua `ctx.api` và truyền `signal: ctx.signal`.
- [ ] `destroy` dừng poll/media/modal/listener; gọi 2 lần không lỗi.
- [ ] Không có `innerHTML`, `eval`, inline handler/style, emoji trong chrome.
- [ ] Không hiển thị mật khẩu/secret; field mật khẩu clear sau submit/đóng.
- [ ] Không render nút admin khi `ctx.isAdmin === false`; server vẫn phải chặn.
- [ ] Đủ test ID trong §15.
- [ ] Responsive 360/768/1024/1440; bàn phím + screen reader cho luồng chính.
- [ ] Không tự quét mạng / không tự gọi hành động nguy hiểm khi mount.
- [ ] Báo rõ phần chưa làm/không kiểm chứng được trong báo cáo.
