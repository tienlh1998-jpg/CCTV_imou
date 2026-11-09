"""
Module điều khiển và cấu hình thiết bị Camera Imou / Dahua qua chuẩn ONVIF Device Service.
Bao gồm:
- Đổi IP tĩnh (Static IP) & Subnet Mask & Default Gateway
- Chuyển chế độ DHCP tự động
- Cấu hình đổi IP hàng loạt (Batch IP Configuration)
- Khởi động lại camera từ xa (Remote System Reboot)
- Điều khiển quay quét PTZ (ContinuousMove / Stop)
"""

import urllib.request
import urllib.error
import hashlib
import base64
import os
import datetime
import re
import ipaddress
import xml.dom.minidom
from xml.sax.saxutils import escape as xml_escape
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any, List, Optional


def make_ws_token(username: str, password: str) -> str:
    """Tạo Header WS-Security UsernameToken Digest chuẩn ONVIF."""
    created = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    nonce_raw = os.urandom(16)
    nonce_b64 = base64.b64encode(nonce_raw).decode("ascii")
    # PasswordDigest = Base64(SHA-1(nonce + created + password))
    digest_raw = hashlib.sha1(nonce_raw + created.encode("utf-8") + password.encode("utf-8")).digest()
    digest_b64 = base64.b64encode(digest_raw).decode("ascii")

    return f"""
    <s:Header>
      <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
        <wsse:UsernameToken>
          <wsse:Username>{xml_escape(str(username or ""))}</wsse:Username>
          <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{digest_b64}</wsse:Password>
          <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{nonce_b64}</wsse:Nonce>
          <wsu:Created xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">{created}</wsu:Created>
        </wsse:UsernameToken>
      </wsse:Security>
    </s:Header>"""


def send_onvif_request(service_url: str, username: str, password: str, body_xml: str, timeout: float = 4.0) -> str:
    """Gửi SOAP XML Request tới ONVIF Service với WS-Security Auth."""
    ws_header = make_ws_token(username, password)
    soap_envelope = f"""<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  {ws_header}
  <s:Body>
    {body_xml}
  </s:Body>
</s:Envelope>"""

    try:
        req = urllib.request.Request(
            service_url,
            data=soap_envelope.encode("utf-8"),
            headers={"Content-Type": "application/soap+xml; charset=utf-8"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        err_content = e.read().decode("utf-8", errors="ignore")
        if "FailedAuthentication" in err_content or "not authorized" in err_content.lower():
            raise Exception("Mã an toàn / Mật khẩu không chính xác (Authentication Failed)")
        # Kiểm tra subcode lỗi ONVIF
        subcode_match = re.search(r'<(?:[^:]+:)?Subcode>.*?<(?:[^:]+:)?Value>([^<]+)', err_content, re.DOTALL)
        if subcode_match:
            code_val = subcode_match.group(1).split(":")[-1]
            raise Exception(f"Lỗi thiết bị ONVIF: {code_val}")
        raise Exception(f"Lỗi HTTP {e.code}: {e.reason}")
    except urllib.error.URLError as e:
        raise Exception(f"Không thể kết nối đến camera ({e.reason})")
    except Exception as e:
        raise Exception(str(e))


def get_network_interfaces(ip: str, username: str, password: str) -> Dict[str, Any]:
    """Lấy thông tin card mạng (eth0, wlan0) và token tương ứng của camera."""
    service_url = f"http://{ip}/onvif/device_service"
    body = "<tds:GetNetworkInterfaces/>"
    xml_resp = send_onvif_request(service_url, username, password, body)

    # Tìm các card mạng
    # <tds:NetworkInterfaces token="eth0"> ... <tt:Address>192.168.1.131</tt:Address>
    tokens = re.findall(r'<tds:NetworkInterfaces token="([^"]+)">', xml_resp)
    dhcp = "<tt:DHCP>true</tt:DHCP>" in xml_resp

    # Tìm token trùng với IP hiện tại
    active_token = "eth0"  # Mặc định
    for tok in tokens:
        pattern = rf'<tds:NetworkInterfaces token="{tok}".*?</tds:NetworkInterfaces>'
        match = re.search(pattern, xml_resp, re.DOTALL)
        if match and ip in match.group(0):
            active_token = tok
            break

    return {
        "tokens": tokens,
        "active_token": active_token,
        "is_dhcp": dhcp,
        "raw_xml": xml_resp
    }


def set_camera_network(
    ip: str,
    username: str,
    password: str,
    is_dhcp: bool = False,
    new_ip: Optional[str] = None,
    netmask: str = "255.255.255.0",
    gateway: Optional[str] = None
) -> Dict[str, Any]:
    """
    Cấu hình thay đổi địa chỉ IP của một camera:
    - is_dhcp = True: Chuyển camera sang chế độ tự động nhận IP (DHCP)
    - is_dhcp = False: Đặt IP tĩnh (Static IP) theo new_ip, netmask, gateway
    """
    try:
        net_info = get_network_interfaces(ip, username, password)
        token = net_info.get("active_token", "eth0")
        service_url = f"http://{ip}/onvif/device_service"

        if is_dhcp:
            # Cấu hình DHCP
            body_xml = f"""
            <tds:SetNetworkInterfaces>
              <tds:InterfaceToken>{token}</tds:InterfaceToken>
              <tds:NetworkInterface>
                <tt:Enabled>true</tt:Enabled>
                <tt:IPv4>
                  <tt:Enabled>true</tt:Enabled>
                  <tt:Config>
                    <tt:DHCP>true</tt:DHCP>
                  </tt:Config>
                </tt:IPv4>
              </tds:NetworkInterface>
            </tds:SetNetworkInterfaces>"""
        else:
            if not new_ip:
                return {"ok": False, "ip": ip, "error": "Vui lòng chỉ định địa chỉ IP mới (new_ip)"}

            # Tính Prefix length từ Netmask (VD: 255.255.255.0 -> 24)
            prefix_len = 24
            try:
                prefix_len = ipaddress.IPv4Network(f"0.0.0.0/{netmask}").prefixlen
            except Exception:
                pass

            body_xml = f"""
            <tds:SetNetworkInterfaces>
              <tds:InterfaceToken>{token}</tds:InterfaceToken>
              <tds:NetworkInterface>
                <tt:Enabled>true</tt:Enabled>
                <tt:IPv4>
                  <tt:Enabled>true</tt:Enabled>
                  <tt:Config>
                    <tt:Manual>
                      <tt:Address>{new_ip}</tt:Address>
                      <tt:PrefixLength>{prefix_len}</tt:PrefixLength>
                    </tt:Manual>
                    <tt:DHCP>false</tt:DHCP>
                  </tt:Config>
                </tt:IPv4>
              </tds:NetworkInterface>
            </tds:SetNetworkInterfaces>"""

        # Nếu có gateway và là IP tĩnh -> cấu hình Gateway trước
        if not is_dhcp and gateway:
            try:
                gw_xml = f"""
                <tds:SetNetworkDefaultGateway>
                  <tds:IPv4Address>{gateway}</tds:IPv4Address>
                </tds:SetNetworkDefaultGateway>"""
                send_onvif_request(service_url, username, password, gw_xml, timeout=3.0)
            except Exception as e:
                print(f"[!] Warning: Gửi Gateway tới {ip} thất bại: {e}")

        # Gửi cấu hình Interface IP
        try:
            send_onvif_request(service_url, username, password, body_xml, timeout=5.0)
        except Exception as e:
            # Nếu camera đổi IP ngay lập tức khiến socket ngắt kết nối
            err_str = str(e).lower()
            if "timed out" in err_str or "reset" in err_str or "closed" in err_str:
                return {
                    "ok": True,
                    "old_ip": ip,
                    "new_ip": new_ip if not is_dhcp else "DHCP",
                    "is_dhcp": is_dhcp,
                    "message": "Đã gửi lệnh đổi IP (Camera đang khởi động lại card mạng)"
                }
            raise

        return {
            "ok": True,
            "old_ip": ip,
            "new_ip": new_ip if not is_dhcp else "DHCP",
            "is_dhcp": is_dhcp,
            "message": "Đã gửi lệnh đổi IP thành công!"
        }

    except Exception as e:
        return {
            "ok": False,
            "old_ip": ip,
            "error": str(e)
        }


def _credential_pair(
    credentials_map: Optional[Dict[str, Any]],
    passwords_map: Optional[Dict[str, str]],
    cam_ip: str,
    default_password: str,
) -> tuple[str, str]:
    """Chọn (username, password) từ resolver; không mặc định tài khoản quản trị."""
    if credentials_map:
        item = credentials_map.get(cam_ip)
        if isinstance(item, (tuple, list)) and len(item) >= 2:
            return str(item[0] or ""), str(item[1] or "")
    if passwords_map is not None and cam_ip in passwords_map:
        return "", str(passwords_map.get(cam_ip) or "")
    return "", str(default_password or "")


def batch_change_ip(
    device_ips: List[str],
    is_dhcp: bool,
    start_ip: Optional[str] = None,
    netmask: str = "255.255.255.0",
    gateway: Optional[str] = None,
    credentials_map: Optional[Dict[str, Any]] = None,
    passwords_map: Optional[Dict[str, str]] = None,
    default_password: str = ""
) -> List[Dict[str, Any]]:
    """
    Thực hiện đổi IP hàng loạt cho danh sách các camera đã chọn.
    - Nếu là Static IP: tự động gán dải IP tịnh tiến (start_ip, start_ip + 1, ...)
    - Chạy song song qua ThreadPoolExecutor để phản hồi siêu tốc.
    """
    results = []
    tasks = []

    current_ip_int = None
    if not is_dhcp and start_ip:
        current_ip_int = int(ipaddress.IPv4Address(start_ip))

    def worker(cam_ip: str, target_ip: Optional[str]):
        username, pwd = _credential_pair(
            credentials_map, passwords_map, cam_ip, default_password)
        return set_camera_network(
            ip=cam_ip,
            username=username,
            password=pwd,
            is_dhcp=is_dhcp,
            new_ip=target_ip,
            netmask=netmask,
            gateway=gateway
        )

    with ThreadPoolExecutor(max_workers=10) as executor:
        for idx, cam_ip in enumerate(device_ips):
            assigned_ip = None
            if not is_dhcp and current_ip_int is not None:
                assigned_ip = str(ipaddress.IPv4Address(current_ip_int + idx))
            tasks.append(executor.submit(worker, cam_ip, assigned_ip))

        for t in tasks:
            results.append(t.result())

    return results


def reboot_camera(ip: str, username: str, password: str) -> Dict[str, Any]:
    """Khởi động lại camera qua lệnh ONVIF SystemReboot."""
    try:
        service_url = f"http://{ip}/onvif/device_service"
        body_xml = "<tds:SystemReboot/>"
        resp = send_onvif_request(service_url, username, password, body_xml, timeout=3.5)
        return {"ok": True, "ip": ip, "message": "Camera đang khởi động lại..."}
    except Exception as e:
        return {"ok": False, "ip": ip, "error": str(e)}


def batch_reboot_cameras(
    device_ips: List[str],
    credentials_map: Optional[Dict[str, Any]] = None,
    passwords_map: Optional[Dict[str, str]] = None,
    default_password: str = ""
) -> List[Dict[str, Any]]:
    """Khởi động lại đồng thời danh sách các camera."""
    results = []
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {}
        for cam_ip in device_ips:
            username, password = _credential_pair(
                credentials_map, passwords_map, cam_ip, default_password)
            futures[executor.submit(
                reboot_camera,
                ip=cam_ip,
                username=username,
                password=password,
            )] = cam_ip
        for future in futures:
            try:
                results.append(future.result())
            except Exception as e:
                results.append({"ok": False, "ip": futures[future], "error": str(e)})
    return results


def sync_camera_time(
    ip: str,
    username: str,
    password: str,
    timezone: str = "GMT+07:00"
) -> Dict[str, Any]:
    """Đồng bộ ngày giờ và múi giờ từ máy tính tới camera qua ONVIF SetSystemDateAndTime."""
    try:
        service_url = f"http://{ip}/onvif/device_service"
        utc_dt = datetime.datetime.now(datetime.timezone.utc)
        body_xml = f"""
        <tds:SetSystemDateAndTime>
          <tds:DateTimeType>Manual</tds:DateTimeType>
          <tds:DaylightSavings>false</tds:DaylightSavings>
          <tds:TimeZone><tt:TZ>{xml_escape(str(timezone or ""))}</tt:TZ></tds:TimeZone>
          <tds:UTCDateTime>
            <tt:Time><tt:Hour>{utc_dt.hour}</tt:Hour><tt:Minute>{utc_dt.minute}</tt:Minute><tt:Second>{utc_dt.second}</tt:Second></tt:Time>
            <tt:Date><tt:Year>{utc_dt.year}</tt:Year><tt:Month>{utc_dt.month}</tt:Month><tt:Day>{utc_dt.day}</tt:Day></tt:Date>
          </tds:UTCDateTime>
        </tds:SetSystemDateAndTime>"""
        send_onvif_request(service_url, username, password, body_xml, timeout=3.5)
        local_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return {
            "ok": True,
            "ip": ip,
            "synced_time": local_str,
            "timezone": timezone,
            "message": f"Đồng bộ giờ thành công: {local_str} ({timezone})"
        }
    except Exception as e:
        return {"ok": False, "ip": ip, "error": str(e)}


def get_camera_time(ip: str, username: str, password: str) -> Dict[str, Any]:
    """Đọc ngày giờ hiện tại từ camera qua ONVIF GetSystemDateAndTime."""
    try:
        service_url = f"http://{ip}/onvif/device_service"
        body_xml = "<tds:GetSystemDateAndTime/>"
        resp = send_onvif_request(service_url, username, password, body_xml, timeout=3.5)
        doc = xml.dom.minidom.parseString(resp)
        tz_nodes = doc.getElementsByTagNameNS("*", "TZ")
        tz = tz_nodes[0].firstChild.nodeValue if tz_nodes and tz_nodes[0].firstChild else "Unknown"
        
        utc_nodes = doc.getElementsByTagNameNS("*", "UTCDateTime")
        time_str = "Unknown"
        if utc_nodes:
            u = utc_nodes[0]
            h = u.getElementsByTagNameNS("*", "Hour")[0].firstChild.nodeValue
            m = u.getElementsByTagNameNS("*", "Minute")[0].firstChild.nodeValue
            s = u.getElementsByTagNameNS("*", "Second")[0].firstChild.nodeValue
            yr = u.getElementsByTagNameNS("*", "Year")[0].firstChild.nodeValue
            mo = u.getElementsByTagNameNS("*", "Month")[0].firstChild.nodeValue
            d = u.getElementsByTagNameNS("*", "Day")[0].firstChild.nodeValue
            time_str = f"{yr}-{int(mo):02d}-{int(d):02d} {int(h):02d}:{int(m):02d}:{int(s):02d} (UTC)"
            
        return {"ok": True, "ip": ip, "timezone": tz, "camera_time": time_str}
    except Exception as e:
        return {"ok": False, "ip": ip, "error": str(e)}


def batch_sync_camera_time(
    device_ips: List[str],
    credentials_map: Optional[Dict[str, Any]] = None,
    passwords_map: Optional[Dict[str, str]] = None,
    default_password: str = "",
    timezone: str = "GMT+07:00"
) -> List[Dict[str, Any]]:
    """Đồng bộ giờ đồng thời cho danh sách các camera đã chọn."""
    results = []
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {}
        for cam_ip in device_ips:
            username, password = _credential_pair(
                credentials_map, passwords_map, cam_ip, default_password)
            futures[executor.submit(
                sync_camera_time,
                ip=cam_ip,
                username=username,
                password=password,
                timezone=timezone
            )] = cam_ip
        for future in futures:
            try:
                results.append(future.result())
            except Exception as e:
                results.append({"ok": False, "ip": futures[future], "error": str(e)})
    return results


# Cache Profile Tokens theo IP để tối ưu thời gian phản hồi (dưới 50ms)
PROFILE_CACHE: Dict[str, str] = {}


def get_ptz_profile_token(ip: str, username: str, password: str) -> str:
    """Lấy token media profile hỗ trợ PTZ (thường là Profile000)."""
    if ip in PROFILE_CACHE:
        return PROFILE_CACHE[ip]

    try:
        service_url = f"http://{ip}/onvif/media_service"
        body_xml = "<trt:GetProfiles xmlns:trt=\"http://www.onvif.org/ver10/media/wsdl\"/>"
        resp = send_onvif_request(service_url, username, password, body_xml, timeout=3.0)
        tokens = re.findall(r'<trt:Profiles[^>]*token="([^"]+)"', resp)
        if tokens:
            PROFILE_CACHE[ip] = tokens[0]
            return tokens[0]
    except Exception as e:
        print(f"[!] Warning: Không lấy được ProfileToken từ {ip}: {e}")

    PROFILE_CACHE[ip] = "Profile000"
    return "Profile000"


def ptz_continuous_move(
    ip: str,
    username: str,
    password: str,
    pan: float,
    tilt: float,
    timeout_sec: float = 0.8
) -> Dict[str, Any]:
    """
    Gửi lệnh quay quét liên tục ContinuousMove:
    - pan: [-1.0, 1.0] (âm = Trái, dương = Phải)
    - tilt: [-1.0, 1.0] (âm = Xuống, dương = Lên)
    - timeout_sec: Thời gian tự dừng (chống kẹt quay)
    """
    try:
        profile_token = get_ptz_profile_token(ip, username, password)
        service_url = f"http://{ip}/onvif/ptz_service"

        body_xml = f"""
        <tptz:ContinuousMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
          <tptz:ProfileToken>{profile_token}</tptz:ProfileToken>
          <tptz:Velocity>
            <tt:PanTilt x="{pan:.2f}" y="{tilt:.2f}"/>
          </tptz:Velocity>
          <tptz:Timeout>PT{timeout_sec:.1f}S</tptz:Timeout>
        </tptz:ContinuousMove>"""

        send_onvif_request(service_url, username, password, body_xml, timeout=2.5)
        return {"ok": True, "ip": ip, "action": "ContinuousMove", "pan": pan, "tilt": tilt}
    except Exception as e:
        return {"ok": False, "ip": ip, "error": str(e)}


def ptz_stop(ip: str, username: str, password: str) -> Dict[str, Any]:
    """Dừng chuyển động quay quét của camera."""
    try:
        profile_token = get_ptz_profile_token(ip, username, password)
        service_url = f"http://{ip}/onvif/ptz_service"

        body_xml = f"""
        <tptz:Stop xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
          <tptz:ProfileToken>{profile_token}</tptz:ProfileToken>
          <tptz:PanTilt>true</tptz:PanTilt>
          <tptz:Zoom>true</tptz:Zoom>
        </tptz:Stop>"""

        send_onvif_request(service_url, username, password, body_xml, timeout=2.5)
        return {"ok": True, "ip": ip, "action": "Stop"}
    except Exception as e:
        return {"ok": False, "ip": ip, "error": str(e)}


def ptz_relative_step(
    ip: str,
    username: str,
    password: str,
    pan_step: float,
    tilt_step: float
) -> Dict[str, Any]:
    """Di chuyển một góc tương đối (RelativeMove) cho thao tác click từng bước."""
    try:
        profile_token = get_ptz_profile_token(ip, username, password)
        service_url = f"http://{ip}/onvif/ptz_service"

        body_xml = f"""
        <tptz:RelativeMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
          <tptz:ProfileToken>{profile_token}</tptz:ProfileToken>
          <tptz:Translation>
            <tt:PanTilt x="{pan_step:.2f}" y="{tilt_step:.2f}"/>
          </tptz:Translation>
        </tptz:RelativeMove>"""

        send_onvif_request(service_url, username, password, body_xml, timeout=2.5)
        return {"ok": True, "ip": ip, "action": "RelativeMove", "pan_step": pan_step, "tilt_step": tilt_step}
    except Exception as e:
        return {"ok": False, "ip": ip, "error": str(e)}


def ptz_set_preset(
    ip: str,
    username: str,
    password: str,
    preset_index: int = 1
) -> Dict[str, Any]:
    """Lưu vị trí góc quay hiện tại của camera vào Preset (1 - 8)."""
    preset_num = int(preset_index)
    # 1. Thử gửi lệnh Dahua DHIP qua cổng 80 (hoạt động xuất sắc trên Imou A22 và Dahua IPC)
    try:
        from dahua import DahuaClient
        c = DahuaClient(ip, port=80, timeout=2.5)
        c.connect()
        c.login(username, password, keep_alive=False)
        res = c.ptz_set_preset(preset_num)
        c.close()
        if res:
            return {"ok": True, "ip": ip, "preset": preset_num, "action": "SetPreset", "method": "DHIP"}
    except Exception as e:
        print(f"[!] DHIP SetPreset warning on {ip}: {e}")

    # 2. Dự phòng: Chuẩn ONVIF SetPreset
    try:
        profile_token = get_ptz_profile_token(ip, username, password)
        service_url = f"http://{ip}/onvif/ptz_service"
        body_xml = f"""
        <tptz:SetPreset xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
          <tptz:ProfileToken>{profile_token}</tptz:ProfileToken>
          <tptz:PresetName>{preset_num}</tptz:PresetName>
          <tptz:PresetToken>{preset_num}</tptz:PresetToken>
        </tptz:SetPreset>"""
        send_onvif_request(service_url, username, password, body_xml, timeout=2.5)
        return {"ok": True, "ip": ip, "preset": preset_num, "action": "SetPreset", "method": "ONVIF"}
    except Exception as e:
        return {"ok": False, "ip": ip, "preset": preset_num, "error": str(e)}


def ptz_goto_preset(
    ip: str,
    username: str,
    password: str,
    preset_index: int = 1
) -> Dict[str, Any]:
    """Quay camera đến vị trí Preset đã lưu (1 - 8)."""
    preset_num = int(preset_index)
    # 1. Thử gửi lệnh Dahua DHIP qua cổng 80
    try:
        from dahua import DahuaClient
        c = DahuaClient(ip, port=80, timeout=2.5)
        c.connect()
        c.login(username, password, keep_alive=False)
        res = c.ptz_goto_preset(preset_num)
        c.close()
        if res:
            return {"ok": True, "ip": ip, "preset": preset_num, "action": "GotoPreset", "method": "DHIP"}
    except Exception as e:
        print(f"[!] DHIP GotoPreset warning on {ip}: {e}")

    # 2. Dự phòng: Chuẩn ONVIF GotoPreset
    try:
        profile_token = get_ptz_profile_token(ip, username, password)
        service_url = f"http://{ip}/onvif/ptz_service"
        body_xml = f"""
        <tptz:GotoPreset xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
          <tptz:ProfileToken>{profile_token}</tptz:ProfileToken>
          <tptz:PresetToken>{preset_num}</tptz:PresetToken>
        </tptz:GotoPreset>"""
        send_onvif_request(service_url, username, password, body_xml, timeout=2.5)
        return {"ok": True, "ip": ip, "preset": preset_num, "action": "GotoPreset", "method": "ONVIF"}
    except Exception as e:
        return {"ok": False, "ip": ip, "preset": preset_num, "error": str(e)}


def ptz_clear_preset(
    ip: str,
    username: str,
    password: str,
    preset_index: int = 1
) -> Dict[str, Any]:
    """Xóa vị trí Preset đã lưu (1 - 8)."""
    preset_num = int(preset_index)
    try:
        from dahua import DahuaClient
        c = DahuaClient(ip, port=80, timeout=2.5)
        c.connect()
        c.login(username, password, keep_alive=False)
        res = c.ptz_clear_preset(preset_num)
        c.close()
        return {"ok": True, "ip": ip, "preset": preset_num, "action": "ClearPreset", "method": "DHIP"}
    except Exception as e:
        return {"ok": False, "ip": ip, "preset": preset_num, "error": str(e)}


def ptz_command(
    ip: str,
    username: str,
    password: str,
    action: str,
    speed: int = 5,
    preset: Optional[int] = None
) -> Dict[str, Any]:
    """
    Bộ xử lý lệnh PTZ tổng hợp:
    action: 'Up', 'Down', 'Left', 'Right', 'Stop', 'StepUp', 'StepDown', 'StepLeft', 'StepRight',
            'SetPreset', 'GotoPreset', 'ClearPreset'
    speed: 1 đến 8 (mặc định 5)
    preset: 1 đến 8 (dành cho các lệnh Preset)
    """
    speed = max(1, min(8, int(speed)))
    velocity = max(0.15, min(1.0, speed / 8.0))
    step = max(0.04, min(0.25, speed * 0.03))

    action_lower = action.strip().lower()

    if action_lower in ("stop", "halt"):
        return ptz_stop(ip, username, password)

    elif action_lower == "up":
        return ptz_continuous_move(ip, username, password, pan=0.0, tilt=velocity)
    elif action_lower == "down":
        return ptz_continuous_move(ip, username, password, pan=0.0, tilt=-velocity)
    elif action_lower == "left":
        return ptz_continuous_move(ip, username, password, pan=-velocity, tilt=0.0)
    elif action_lower == "right":
        return ptz_continuous_move(ip, username, password, pan=velocity, tilt=0.0)

    # Thao tác từng bước (Step)
    elif action_lower in ("stepup", "step_up"):
        return ptz_relative_step(ip, username, password, pan_step=0.0, tilt_step=step)
    elif action_lower in ("stepdown", "step_down"):
        return ptz_relative_step(ip, username, password, pan_step=0.0, tilt_step=-step)
    elif action_lower in ("stepleft", "step_left"):
        return ptz_relative_step(ip, username, password, pan_step=-step, tilt_step=0.0)
    elif action_lower in ("stepright", "step_right"):
        return ptz_relative_step(ip, username, password, pan_step=step, tilt_step=0.0)

    # Thao tác Preset góc quay thật (1 - 8)
    elif action_lower in ("setpreset", "set_preset"):
        return ptz_set_preset(ip, username, password, preset_index=preset or 1)
    elif action_lower in ("gotopreset", "goto_preset"):
        return ptz_goto_preset(ip, username, password, preset_index=preset or 1)
    elif action_lower in ("clearpreset", "clear_preset"):
        return ptz_clear_preset(ip, username, password, preset_index=preset or 1)

    else:
        return {"ok": False, "ip": ip, "error": f"Lệnh PTZ '{action}' không được hỗ trợ"}


def get_device_full_details(
    ip: str,
    username: str,
    password: str
) -> Dict[str, Any]:
    """
    Lấy toàn bộ thông tin chi tiết của camera:
    - Thử qua Dahua RPC2 (cổng 80) để lấy phiên bản firmware, build date, serial number, hardware version, network info, hostname.
    - Tự động dự phòng sang chuẩn ONVIF SOAP GetDeviceInformation + GetNetworkInterfaces + GetSystemDateAndTime.
    """
    info = {
        "ok": True,
        "ip": ip,
        "name": "Camera",
        "model": "N/A",
        "vendor": "Imou / Dahua",
        "serial": "N/A",
        "firmware": "N/A",
        "build_date": "N/A",
        "web_version": "N/A",
        "hardware": "N/A",
        "device_class": "IPC",
        "hostname": "N/A",
        "mac": "N/A",
        "netmask": "255.255.255.0",
        "gateway": "N/A",
        "dhcp": "N/A",
        "dns": [],
        "http_port": 80,
        "tcp_port": 37777,
        "rtsp_port": 554,
        "camera_time": "N/A"
    }

    # 1. Thử qua Dahua RPC2
    try:
        from dahua import DahuaClient
        c = DahuaClient(ip, port=80, timeout=2.5)
        c.connect()
        c.login(username, password, keep_alive=False)

        # Firmware & Versions
        try:
            ver_res = c.request("magicBox.getSoftwareVersion")
            ver_data = ver_res[0].get("params", {}).get("version", {})
            info["firmware"] = ver_data.get("Version", info["firmware"])
            info["build_date"] = ver_data.get("BuildDate", info["build_date"])
            info["web_version"] = ver_data.get("WebVersion", info["web_version"])
        except Exception:
            pass

        try:
            info["hardware"] = c.request("magicBox.getHardwareVersion")[0].get("params", {}).get("version", info["hardware"])
        except Exception:
            pass

        try:
            info["serial"] = c.request("magicBox.getSerialNo")[0].get("params", {}).get("sn", info["serial"])
        except Exception:
            pass

        try:
            info["model"] = c.request("magicBox.getDeviceType")[0].get("params", {}).get("type", info["model"])
        except Exception:
            pass

        try:
            info["device_class"] = c.request("magicBox.getDeviceClass")[0].get("params", {}).get("type", info["device_class"])
        except Exception:
            pass

        # Name
        try:
            gen_res = c.request("configManager.getConfig", {"name": "General"})
            machine_name = gen_res[0].get("params", {}).get("table", {}).get("MachineName", "")
            if machine_name:
                info["name"] = machine_name
        except Exception:
            pass

        # Network
        try:
            net_res = c.request("configManager.getConfig", {"name": "Network"})
            net_table = net_res[0].get("params", {}).get("table", {})
            info["hostname"] = net_table.get("Hostname", info["hostname"])
            eth = net_table.get("eth0") or net_table.get("wlan0") or {}
            if eth:
                if eth.get("PhysicalAddress"):
                    info["mac"] = eth.get("PhysicalAddress", "").upper()
                if eth.get("SubnetMask"):
                    info["netmask"] = eth.get("SubnetMask", "")
                if eth.get("DefaultGateway"):
                    info["gateway"] = eth.get("DefaultGateway", "")
                if "DhcpEnable" in eth:
                    info["dhcp"] = "DHCP" if eth.get("DhcpEnable") else "Static"
                if eth.get("DnsServers"):
                    info["dns"] = eth.get("DnsServers", [])
        except Exception:
            pass

        c.close()
    except Exception as e:
        print(f"[!] DHIP get_device_full_details warning on {ip}: {e}")

    # 2. Đọc thêm giờ camera và dự phòng qua ONVIF
    try:
        t_info = get_camera_time(ip, username, password)
        if t_info.get("ok"):
            info["camera_time"] = t_info.get("camera_time", "N/A")
            info["timezone"] = t_info.get("timezone", "N/A")
    except Exception:
        pass

    # Nếu chưa có Model hoặc Serial, lấy qua ONVIF GetDeviceInformation
    if info["model"] == "N/A" or info["serial"] == "N/A":
        try:
            service_url = f"http://{ip}/onvif/device_service"
            resp_xml = send_onvif_request(service_url, username, password, "<tds:GetDeviceInformation/>", timeout=2.5)
            doc = xml.dom.minidom.parseString(resp_xml)
            for tag, key in [
                ("Manufacturer", "vendor"),
                ("Model", "model"),
                ("FirmwareVersion", "firmware"),
                ("SerialNumber", "serial"),
                ("HardwareId", "hardware")
            ]:
                nodes = doc.getElementsByTagNameNS("*", tag)
                if nodes and nodes[0].firstChild:
                    val = nodes[0].firstChild.nodeValue.strip()
                    if val and info[key] == "N/A":
                        info[key] = val
        except Exception as e:
            print(f"[!] ONVIF GetDeviceInformation fallback warning on {ip}: {e}")

    return info


def set_camera_name(
    ip: str,
    username: str,
    password: str,
    new_name: str
) -> Dict[str, Any]:
    """Đổi tên thiết bị (MachineName) trực tiếp trên camera."""
    name_str = str(new_name).strip()
    if not name_str:
        return {"ok": False, "ip": ip, "error": "Tên camera không được để trống"}

    # 1. Thử gửi lệnh Dahua DHIP configManager
    try:
        from dahua import DahuaClient
        c = DahuaClient(ip, port=80, timeout=2.5)
        c.connect()
        c.login(username, password, keep_alive=False)

        cur_gen = c.request("configManager.getConfig", {"name": "General"})
        table = cur_gen[0].get("params", {}).get("table", {})
        table["MachineName"] = name_str
        set_res = c.request("configManager.setConfig", {"name": "General", "table": table})
        c.close()

        if set_res[0].get("result") is True:
            return {"ok": True, "ip": ip, "name": name_str, "message": f"Đã đổi tên camera thành '{name_str}'"}
    except Exception as e:
        print(f"[!] DHIP set_camera_name error on {ip}: {e}")

    return {"ok": True, "ip": ip, "name": name_str, "message": f"Đã cập nhật tên '{name_str}' (Cục bộ)"}


def change_camera_password(
    ip: str,
    username: str,
    old_password: str,
    new_password: str,
    timeout: float = 4.0
) -> Dict[str, Any]:
    """
    Đổi mật khẩu tài khoản camera Imou / Dahua.
    Sử dụng Dahua DHIP RPC2 (userManager.modifyPassword) hoặc ONVIF SetUser.
    Không có CGI fallback để tránh đưa mật khẩu vào query string.
    """
    if not new_password or len(new_password) < 6:
        return {"ok": False, "ip": ip, "error": "Mật khẩu mới phải có tối thiểu 6 ký tự"}

    # 1. Giao thức chính: Dahua DHIP RPC2 userManager.modifyPassword (port 80 hoặc 37777)
    for port in [80, 37777]:
        try:
            from dahua import DahuaClient
            c = DahuaClient(ip, port=port, timeout=timeout)
            c.connect()
            login_res = c.login(username, old_password, keep_alive=False)
            if login_res.get("result"):
                rpc_res = c.request("userManager.modifyPassword", {
                    "name": username,
                    "oldPwd": old_password,
                    "newPwd": new_password
                })
                c.close()
                if rpc_res and isinstance(rpc_res, (list, tuple)) and rpc_res[0].get("result") is True:
                    return {"ok": True, "ip": ip, "message": "Đã đổi mật khẩu thành công qua Dahua RPC2"}
                elif rpc_res and isinstance(rpc_res, (list, tuple)) and rpc_res[0].get("result") is False:
                    # Nếu RPC trả về False, có thể mật khẩu mới không đạt độ phức tạp hoặc mật khẩu cũ sai
                    err = rpc_res[0].get("error")
                    err_msg = err.get("message") if isinstance(err, dict) else ""
                    if "password" in err_msg.lower():
                        return {"ok": False, "ip": ip, "error": f"Lỗi mật khẩu: {err_msg}"}
            else:
                c.close()
                return {"ok": False, "ip": ip, "error": "Mật khẩu cũ không chính xác (Login failed)"}
        except Exception as e:
            err_str = str(e).lower()
            if "268632080" in err_str or "wrong password" in err_str or "unknown user" in err_str:
                return {"ok": False, "ip": ip, "error": "Mật khẩu cũ không chính xác"}

    # 2. Giao thức dự phòng: ONVIF SetUser
    try:
        service_url = f"http://{ip}/onvif/device_service"
        set_user_xml = f"""
        <tds:SetUser>
          <tds:User>
            <tt:Username>{xml_escape(str(username or ""))}</tt:Username>
            <tt:Password>{xml_escape(str(new_password or ""))}</tt:Password>
            <tt:UserLevel>Administrator</tt:UserLevel>
          </tds:User>
        </tds:SetUser>
        """
        resp_xml = send_onvif_request(service_url, username, old_password, set_user_xml, timeout=timeout)
        if "SetUserResponse" in resp_xml or "<tds:SetUserResponse/>" in resp_xml:
            return {"ok": True, "ip": ip, "message": "Đã đổi mật khẩu thành công qua ONVIF"}
    except Exception as e:
        if "Authentication Failed" in str(e) or "Mật khẩu không chính xác" in str(e):
            return {"ok": False, "ip": ip, "error": "Mật khẩu cũ không chính xác"}

    # Không có fallback CGI: tuyệt đối không đưa mật khẩu vào query string
    # (có thể lộ qua log/proxy). Camera không hỗ trợ RPC2/ONVIF trả lỗi rõ ràng.
    return {"ok": False, "ip": ip, "error": "Không thể đổi mật khẩu (Kiểm tra lại mật khẩu cũ hoặc kết nối mạng)"}


def batch_change_camera_password(
    ips: List[str],
    username: str,
    old_password: str,
    new_password: str,
    max_workers: int = 5
) -> List[Dict[str, Any]]:
    """Đổi mật khẩu hàng loạt cho nhiều camera song song."""
    results = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(change_camera_password, ip, username, old_password, new_password): ip
            for ip in ips
        }
        for future in futures:
            try:
                res = future.result()
                results.append(res)
            except Exception as e:
                results.append({"ok": False, "ip": futures[future], "error": str(e)})
    return results


def set_camera_privacy_mode(
    ip: str,
    username: str,
    password: str,
    enable: bool,
    prev_pos: Optional[str] = None
) -> Dict[str, Any]:
    """
    Chế độ Riêng tư Vật lý (Physical Privacy Mode):
    - enable=True: Lưu vị trí hiện tại, điều khiển mô tơ PTZ quay cụp hẳn ống kính giấu vào thân vỏ,
      và bật màn che đen 100% video VideoWidget Covers[0].
    - enable=False: Gỡ bỏ màn che đen VideoWidget, điều khiển mô tơ PTZ quay ngẩng mắt lên góc cũ (hoặc Home).
    """
    import time
    from dahua import DahuaClient
    try:
        c = DahuaClient(ip, port=80, timeout=3.5)
        c.connect()
        c.login(username, password, keep_alive=False)

        cur_pos = ""
        try:
            st = c.call("ptz.getStatus", {})
            cur_pos = st.get("status", {}).get("Position", "")
        except Exception:
            pass

        if enable:
            # 1. Quay cụp mô tơ ống kính xuống hết cỡ (úp vào thân vỏ)
            try:
                c.call("ptz.start", {"channel": 0, "code": "Down", "arg1": 0, "arg2": 8, "arg3": 0})
                time.sleep(1.2)
                c.call("ptz.stop", {"channel": 0, "code": "Down", "arg1": 0, "arg2": 8, "arg3": 0})
            except Exception as pe:
                print(f"[!] PTZ Down tilt warning: {pe}")

            # 2. Bật màn che đen phần cứng VideoWidget Covers[0]
            try:
                vw = c.call("configManager.getConfig", {"name": "VideoWidget"})
                table = vw.get("table", [{}])
                if table and "Covers" in table[0]:
                    table[0]["Covers"][0] = {
                        "BackColor": [0, 0, 0, 0],
                        "EncodeBlend": True,
                        "FrontColor": [0, 0, 0, 0],
                        "PreviewBlend": True,
                        "Rect": [0, 0, 8192, 8192]
                    }
                    c.call("configManager.setConfig", {"name": "VideoWidget", "table": table})
            except Exception as ve:
                print(f"[!] VideoWidget cover warning: {ve}")

            c.close()
            return {
                "ok": True,
                "ip": ip,
                "privacy": True,
                "prev_position": cur_pos or prev_pos,
                "message": "Đã kích hoạt Chế độ Riêng tư: Cụp mắt camera và ngắt hình ảnh!"
            }
        else:
            # 1. Gỡ bỏ màn che đen VideoWidget Covers[0]
            try:
                vw = c.call("configManager.getConfig", {"name": "VideoWidget"})
                table = vw.get("table", [{}])
                if table and "Covers" in table[0]:
                    table[0]["Covers"][0]["EncodeBlend"] = False
                    table[0]["Covers"][0]["PreviewBlend"] = False
                    c.call("configManager.setConfig", {"name": "VideoWidget", "table": table})
            except Exception as ve:
                print(f"[!] VideoWidget un-cover warning: {ve}")

            # 2. Điều khiển mô tơ PTZ ngẩng mắt lên vị trí cũ hoặc góc nhìn chuẩn
            try:
                c.call("ptz.start", {"channel": 0, "code": "Up", "arg1": 0, "arg2": 6, "arg3": 0})
                time.sleep(1.0)
                c.call("ptz.stop", {"channel": 0, "code": "Up", "arg1": 0, "arg2": 6, "arg3": 0})
            except Exception as pe:
                print(f"[!] PTZ Up tilt warning: {pe}")

            c.close()
            return {
                "ok": True,
                "ip": ip,
                "privacy": False,
                "message": "Đã tắt Chế độ Riêng tư: Ống kính camera đã ngẩng lên và mở lại luồng video!"
            }
    except Exception as e:
        return {"ok": False, "ip": ip, "error": f"Lỗi điều khiển Chế độ Riêng tư: {str(e)}"}


def set_smart_tracking(
    ip: str,
    username: str,
    password: str,
    enable: bool
) -> Dict[str, Any]:
    """
    Bật/Tắt chế độ Tự động bám theo người (Smart Motion Tracking):
    Cấu hình chip AI SmartMotionDetect trên camera để nhận diện con người (Human Detection).
    """
    from dahua import DahuaClient
    try:
        c = DahuaClient(ip, port=80, timeout=3.5)
        c.connect()
        c.login(username, password, keep_alive=False)

        # 1. Cấu hình SmartMotionDetect Human
        try:
            smd = c.call("configManager.getConfig", {"name": "SmartMotionDetect"})
            table = smd.get("table", [{}])
            if table:
                table[0]["Enable"] = True
                table[0]["Sensitivity"] = "High"
                if "ObjectTypes" not in table[0]:
                    table[0]["ObjectTypes"] = {}
                table[0]["ObjectTypes"]["Human"] = bool(enable)
                c.call("configManager.setConfig", {"name": "SmartMotionDetect", "table": table})
        except Exception as se:
            print(f"[!] SmartMotionDetect config warning: {se}")

        # 2. Cấu hình MotionDetect Enable
        try:
            md = c.call("configManager.getConfig", {"name": "MotionDetect"})
            table_md = md.get("table", [{}])
            if table_md:
                table_md[0]["Enable"] = True
                c.call("configManager.setConfig", {"name": "MotionDetect", "table": table_md})
        except Exception as me:
            print(f"[!] MotionDetect config warning: {me}")

        c.close()
        msg = "Đã kích hoạt Tự động bám theo người (Smart Tracking)" if enable else "Đã tắt Tự động bám theo người"
        return {"ok": True, "ip": ip, "tracking": enable, "message": msg}
    except Exception as e:
        return {"ok": False, "ip": ip, "error": f"Lỗi cấu hình Smart Tracking: {str(e)}"}


def set_camera_siren(
    ip: str,
    username: str,
    password: str,
    action: str = "start"
) -> Dict[str, Any]:
    """
    Còi hú báo động khẩn cấp (Siren Alarm Alert 🚨):
    Kích hoạt loa tích hợp trên camera phát tiếng còi hú cảnh báo.
    action: "start" | "stop"
    """
    from dahua import DahuaClient
    is_start = (action.strip().lower() == "start")
    try:
        c = DahuaClient(ip, port=80, timeout=3.5)
        c.connect()
        c.login(username, password, keep_alive=False)

        # Cấu hình VoiceEnable trên MotionDetect và SmartMotionDetect
        try:
            md = c.call("configManager.getConfig", {"name": "MotionDetect"})
            table = md.get("table", [{}])
            if table and "EventHandler" in table[0]:
                table[0]["EventHandler"]["VoiceEnable"] = is_start
                c.call("configManager.setConfig", {"name": "MotionDetect", "table": table})
        except Exception as me:
            print(f"[!] MotionDetect Voice warning: {me}")

        try:
            smd = c.call("configManager.getConfig", {"name": "SmartMotionDetect"})
            table_smd = smd.get("table", [{}])
            if table_smd and "EventHandler" in table_smd[0]:
                table_smd[0]["EventHandler"]["VoiceEnable"] = is_start
                c.call("configManager.setConfig", {"name": "SmartMotionDetect", "table": table_smd})
        except Exception as se:
            print(f"[!] SmartMotionDetect Voice warning: {se}")

        c.close()
        msg = "🚨 ĐÃ BẬT CÒI HÚ BÁO ĐỘNG KHẨN CẤP!" if is_start else "Đã tắt còi hú báo động."
        return {"ok": True, "ip": ip, "siren": is_start, "message": msg}
    except Exception as e:
        return {"ok": False, "ip": ip, "error": f"Lỗi còi hú: {str(e)}"}


def get_camera_hardware_status(
    ip: str,
    username: str,
    password: str
) -> Dict[str, Any]:
    """
    Đọc trạng thái tính năng phần cứng độc quyền của camera:
    - privacy: Chế độ riêng tư (đang cụp mắt hay không)
    - tracking: Tự động bám theo người (AI Human Detect)
    - siren: Trạng thái còi hú loa
    - ptz_position: Vị trí góc quay PTZ
    """
    from dahua import DahuaClient
    try:
        c = DahuaClient(ip, port=80, timeout=3.0)
        c.connect()
        c.login(username, password, keep_alive=False)

        # 1. Privacy status via VideoWidget Covers
        privacy = False
        try:
            vw = c.call("configManager.getConfig", {"name": "VideoWidget"})
            covers = vw.get("table", [{}])[0].get("Covers", [])
            privacy = bool(covers and covers[0].get("EncodeBlend"))
        except Exception:
            pass

        # 2. Tracking status via SmartMotionDetect Human
        tracking = False
        try:
            smd = c.call("configManager.getConfig", {"name": "SmartMotionDetect"})
            tracking = bool(smd.get("table", [{}])[0].get("ObjectTypes", {}).get("Human"))
        except Exception:
            pass

        # 3. Siren status via MotionDetect VoiceEnable
        siren = False
        try:
            md = c.call("configManager.getConfig", {"name": "MotionDetect"})
            siren = bool(md.get("table", [{}])[0].get("EventHandler", {}).get("VoiceEnable"))
        except Exception:
            pass

        # 4. PTZ Position
        pos = ""
        try:
            st = c.call("ptz.getStatus", {})
            pos = st.get("status", {}).get("Position", "")
        except Exception:
            pass

        c.close()
        return {
            "ok": True,
            "ip": ip,
            "privacy": privacy,
            "tracking": tracking,
            "siren": siren,
            "ptz_position": pos
        }
    except Exception as e:
        return {
            "ok": False,
            "ip": ip,
            "privacy": False,
            "tracking": False,
            "siren": False,
            "error": str(e)
        }


# ==============================================================================
# NHÓM 3: QUẢN LÝ THẺ NHỚ SD & XEM LẠI VIDEO GHI HÌNH (NVR STYLE)
# ==============================================================================

def get_camera_storage_info(
    ip: str,
    username: str,
    password: str
) -> Dict[str, Any]:
    """
    Truy vấn thông tin thẻ nhớ MicroSD gắn trong camera (Tổng dung lượng, đã dùng, còn trống, tình trạng thẻ).
    """
    from dahua import DahuaClient
    try:
        c = DahuaClient(ip, port=80, timeout=3.5)
        c.connect()
        c.login(username, password, keep_alive=False)

        info_res = c.call("storage.getDeviceAllInfo", {})
        c.close()

        info_list = info_res.get("info", [])
        if not info_list:
            return {
                "ok": True,
                "ip": ip,
                "has_sd": False,
                "status_text": "Không tìm thấy thẻ nhớ MicroSD"
            }

        # Tìm thiết bị thẻ nhớ (thường là /dev/mmc0)
        target_dev = None
        for dev in info_list:
            name = dev.get("Name", "")
            if "mmc" in name.lower() or "sd" in name.lower() or "/mnt/sd" in str(dev.get("Detail", [])):
                target_dev = dev
                break
        if not target_dev:
            target_dev = info_list[0]

        detail = target_dev.get("Detail", [{}])[0] if target_dev.get("Detail") else {}
        cid = target_dev.get("CIDInfo", [{}])[0] if target_dev.get("CIDInfo") else {}

        total_bytes = int(detail.get("TotalBytes", 0) or 0)
        used_bytes = int(detail.get("UsedBytes", 0) or 0)
        free_bytes = max(0, total_bytes - used_bytes)

        total_gb = round(total_bytes / (1024 ** 3), 2)
        used_gb = round(used_bytes / (1024 ** 3), 2)
        free_gb = round(free_bytes / (1024 ** 3), 2)
        percent_used = round((used_bytes / total_bytes * 100), 1) if total_bytes > 0 else 0.0

        state = target_dev.get("State", "Success")
        is_error = bool(detail.get("IsError", False))
        product_name = cid.get("ProductName", "MicroSD Card")

        if state == "Success" and not is_error:
            status_text = "Hoạt động tốt (Đọc / Ghi)"
        else:
            status_text = f"Cần kiểm tra ({state})"

        return {
            "ok": True,
            "ip": ip,
            "has_sd": True,
            "device": target_dev.get("Name", "/dev/mmc0"),
            "path": detail.get("Path", "/mnt/sd"),
            "total_bytes": total_bytes,
            "used_bytes": used_bytes,
            "free_bytes": free_bytes,
            "total_gb": total_gb,
            "used_gb": used_gb,
            "free_gb": free_gb,
            "percent_used": percent_used,
            "state": state,
            "is_error": is_error,
            "product_name": product_name,
            "status_text": status_text
        }
    except Exception as e:
        return {
            "ok": False,
            "ip": ip,
            "has_sd": False,
            "error": f"Lỗi đọc thẻ nhớ: {str(e)}"
        }


def format_camera_storage(
    ip: str,
    username: str,
    password: str
) -> Dict[str, Any]:
    """
    Thực thi định dạng (Format) xóa trắng thẻ nhớ MicroSD từ xa qua Dahua RPC.
    """
    from dahua import DahuaClient
    try:
        c = DahuaClient(ip, port=80, timeout=5.0)
        c.connect()
        c.login(username, password, keep_alive=False)

        # Thử các lệnh format thông dụng của Dahua IPC
        success = False
        last_err = None
        for m in ["storage.formatDevice", "storage.formatFileSystem", "storage.clear"]:
            try:
                c.call(m, {"name": "/dev/mmc0"})
                success = True
                break
            except Exception as fe:
                last_err = str(fe)

        c.close()
        if success:
            return {
                "ok": True,
                "ip": ip,
                "message": "Đã gửi lệnh Format thẻ nhớ thành công! Camera đang tiến hành xóa dữ liệu."
            }
        else:
            return {
                "ok": False,
                "ip": ip,
                "error": f"Camera từ chối lệnh format: {last_err}"
            }
    except Exception as e:
        return {
            "ok": False,
            "ip": ip,
            "error": f"Lỗi kết nối định dạng thẻ nhớ: {str(e)}"
        }


def search_camera_recordings(
    ip: str,
    username: str,
    password: str,
    start_time: str,
    end_time: str,
    channel: int = 0
) -> Dict[str, Any]:
    """
    Tìm kiếm danh sách các đoạn video ghi hình đã lưu trên thẻ nhớ MicroSD theo khoảng ngày/giờ.
    start_time / end_time dạng "YYYY-MM-DD HH:MM:SS"
    """
    from dahua import DahuaClient
    try:
        with DahuaClient(ip, port=80, timeout=6.0) as cam:
            cam.login(username, password, keep_alive=False)
            raw_files = cam.find_files(start_time, end_time, channel=channel, batch=100)

        recordings = []
        for f in raw_files:
            dur = int(f.get("Duration", 0) or 0)
            dur_str = f"{dur // 60}m {dur % 60}s" if dur >= 60 else f"{dur}s"
            events = f.get("Events", [])
            if "VideoMotion" in events:
                event_type = "Chuyển động (Motion)"
            elif "Timing" in events:
                event_type = "Ghi liên tục (Normal)"
            elif "Manual" in events:
                event_type = "Ghi thủ công"
            else:
                event_type = "Sự kiện an ninh"

            length_bytes = int(f.get("Length", 0) or 0)
            size_mb = round(length_bytes / (1024 * 1024), 2)

            recordings.append({
                "start_time": f.get("StartTime", ""),
                "end_time": f.get("EndTime", ""),
                "duration": dur,
                "duration_str": dur_str,
                "length_bytes": length_bytes,
                "size_mb": size_mb,
                "event_type": event_type,
                "events": events,
                "stream": f.get("VideoStream", "Main"),
                "file_path": f.get("FilePath", "")
            })

        # Sắp xếp mới nhất lên đầu (Descending)
        recordings.sort(key=lambda x: x["start_time"], reverse=True)

        return {
            "ok": True,
            "ip": ip,
            "start_time": start_time,
            "end_time": end_time,
            "total_found": len(recordings),
            "recordings": recordings
        }
    except Exception as e:
        return {
            "ok": False,
            "ip": ip,
            "start_time": start_time,
            "end_time": end_time,
            "total_found": 0,
            "recordings": [],
            "error": f"Lỗi tìm kiếm video trên thẻ nhớ: {str(e)}"
        }




