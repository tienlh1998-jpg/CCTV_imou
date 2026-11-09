package com.cctv.visionhub;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {

    private static final String PREFS_NAME = "CCTV_HUB_PREFS";
    private static final String KEY_SERVER_URL = "server_url";
    /* Không hardcode IP nội bộ: người dùng cấu hình máy chủ ở lần mở đầu tiên. */
    private static final String DEFAULT_URL = "";

    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout layoutError;
    private TextView tvCurrentServer;
    private Button btnRetry;
    private Button btnChangeIp;
    private ImageButton btnServerSettings;

    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private FrameLayout fullscreenContainer;

    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // Giữ màn hình luôn sáng khi xem camera giám sát
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);
        layoutError = findViewById(R.id.layoutError);
        tvCurrentServer = findViewById(R.id.tvCurrentServer);
        btnRetry = findViewById(R.id.btnRetry);
        btnChangeIp = findViewById(R.id.btnChangeIp);
        btnServerSettings = findViewById(R.id.btnServerSettings);

        setupWebView();

        btnRetry.setOnClickListener(v -> reloadApp());
        btnChangeIp.setOnClickListener(v -> showServerSettingsDialog());
        btnServerSettings.setOnClickListener(v -> showServerSettingsDialog());

        loadCurrentServer();
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        // Bật Mixed Content để nhận luồng video HTTP/MJPEG
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // Tự động phát video không cần chờ chạm màn hình
        settings.setMediaPlaybackRequiresUserGesture(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                layoutError.setVisibility(View.GONE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showErrorScreen();
                }
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showErrorScreen();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                if (newProgress == 100) {
                    progressBar.setVisibility(View.GONE);
                }
            }

            // Hỗ trợ xem video toàn màn hình (Fullscreen Video)
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                fullscreenContainer = new FrameLayout(MainActivity.this);
                fullscreenContainer.setBackgroundColor(0xFF000000);
                fullscreenContainer.addView(customView, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                ((ViewGroup) getWindow().getDecorView()).addView(fullscreenContainer);
                webView.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                webView.setVisibility(View.VISIBLE);
                ((ViewGroup) getWindow().getDecorView()).removeView(fullscreenContainer);
                fullscreenContainer = null;
                customView = null;
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                return super.onConsoleMessage(consoleMessage);
            }
        });
    }

    private void loadCurrentServer() {
        String url = prefs.getString(KEY_SERVER_URL, DEFAULT_URL);
        if (url == null || url.trim().isEmpty()) {
            tvCurrentServer.setText(R.string.server_not_configured);
            showServerSettingsDialog();
            return;
        }
        tvCurrentServer.setText(url);
        webView.loadUrl(url);
    }

    private void reloadApp() {
        layoutError.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        loadCurrentServer();
    }

    private void showErrorScreen() {
        progressBar.setVisibility(View.GONE);
        webView.setVisibility(View.GONE);
        layoutError.setVisibility(View.VISIBLE);
        String current = prefs.getString(KEY_SERVER_URL, DEFAULT_URL);
        tvCurrentServer.setText(current);
    }

    private void showServerSettingsDialog() {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle(R.string.server_settings_title);

        final EditText input = new EditText(this);
        String currentUrl = prefs.getString(KEY_SERVER_URL, DEFAULT_URL);
        input.setText(currentUrl);
        input.setHint(R.string.server_settings_hint);
        input.setSingleLine(true);
        input.setPadding(40, 30, 40, 30);

        builder.setView(input);

        builder.setPositiveButton(R.string.btn_save, (dialog, which) -> {
            String newUrl = input.getText().toString().trim();
            if (!newUrl.isEmpty()) {
                if (!newUrl.startsWith("http://") && !newUrl.startsWith("https://")) {
                    newUrl = "http://" + newUrl;
                }
                prefs.edit().putString(KEY_SERVER_URL, newUrl).apply();
                Toast.makeText(MainActivity.this, "Đã lưu máy chủ: " + newUrl, Toast.LENGTH_SHORT).show();
                reloadApp();
            }
        });

        builder.setNegativeButton(R.string.btn_cancel, (dialog, which) -> dialog.cancel());

        builder.show();
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            WebChromeClient client = new WebChromeClient();
            client.onHideCustomView();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
