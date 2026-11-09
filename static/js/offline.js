/* Trang offline tối giản: chỉ xử lý nút thử lại, không dùng nội dung HTML động. */
(function () {
  'use strict';

  var button = document.getElementById('offline-retry');
  if (button) {
    button.addEventListener('click', function () {
      window.location.reload();
    });
  }
})();
