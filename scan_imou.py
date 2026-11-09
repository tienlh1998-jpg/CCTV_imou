#!/usr/bin/env python3
"""
Imou / Dahua LAN Device Discovery Tool
Tương tự như Imou Config Tool / Dahua ConfigTool
Sử dụng giao thức DHDiscover (DHIP) qua UDP port 37810
"""

import argparse
import json
import csv
import socket
import struct
import time
import sys
import uuid
import re
import urllib.parse
import threading
from typing import List, Dict, Any, Optional

# Protocol constants
DHIP_MAGIC = 0x50494844  # b"DHIP"
HEADER_SIZE = 32
HEADER_FMT = "<IIIIIIII"
DISCOVER_PORT = 37810
MULTICAST_GROUP = "239.255.255.251"


def build_probe_packet(method: str = "DHDiscover.search", params: Optional[dict] = None) -> bytes:
    """Tạo gói tin DHIP discovery có header 32-byte chuẩn Dahua."""
    if params is None:
        params = {"mac": "", "uni": 1}
    payload = {"method": method, "params": params}
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    header = struct.pack(
        HEADER_FMT,
        HEADER_SIZE,
        DHIP_MAGIC,
        0,          # sessionID
        0,          # requestID
        len(body),  # packageLength
        0,          # packageIndex
        len(body),  # messageLength
        0           # dataLength
    )
    return header + body


def parse_device_packet(data: bytes) -> Optional[Dict[str, Any]]:
    """Phân tích dữ liệu phản hồi từ camera/NVR (hỗ trợ DHIP JSON và DVRIP nhị phân)."""
    if len(data) < 16:
        return None

    # Hỗ trợ gói tin nhị phân DVRIP b'\xb3\x00'
    if data[:2] == b'\xb3\x00':
        raw_name = data[40:70].decode('utf-8', errors='ignore')
        clean_name = raw_name.split('\x00')[0].strip()
        clean_name = "".join(ch for ch in clean_name if ch.isprintable()).strip()
        return {
            "method": "client.notifyDevInfo",
            "params": {
                "deviceInfo": {
                    "DeviceType": "Dahua (DVRIP)",
                    "MachineName": clean_name or "Dahua Device",
                    "SerialNo": clean_name,
                    "DeviceClass": "IPC",
                    "Port": 37777
                }
            }
        }

    try:
        magic = struct.unpack_from(HEADER_FMT, data)[1] if len(data) >= HEADER_SIZE else 0
        if magic == DHIP_MAGIC:
            body_bytes = data[HEADER_SIZE:]
        else:
            body_bytes = data
        
        raw_str = body_bytes.decode("utf-8", errors="ignore")
        start_idx = raw_str.find('{')
        end_idx = raw_str.rfind('}')
        if start_idx != -1 and end_idx > start_idx:
            clean_json = raw_str[start_idx:end_idx + 1]
            return json.loads(clean_json)
    except Exception:
        return None
    return None


def get_arp_table() -> Dict[str, str]:
    """Đọc bảng ARP cục bộ (IP -> MAC) từ /proc/net/arp, ip neigh (Linux) hoặc arp -a (Windows)."""
    import sys
    arp_map = {}
    try:
        with open("/proc/net/arp", "r") as f:
            for line in f.readlines()[1:]:
                parts = line.split()
                if len(parts) >= 4:
                    ip = parts[0]
                    mac = parts[3].upper()
                    if mac != "00:00:00:00:00:00" and len(mac) == 17:
                        arp_map[ip] = mac
    except Exception:
        pass
    if not arp_map:
        try:
            import subprocess
            if sys.platform == "win32":
                res = subprocess.run(["arp", "-a"], capture_output=True, text=True)
                for line in res.stdout.splitlines():
                    parts = line.split()
                    if len(parts) >= 2 and "." in parts[0] and ("-" in parts[1] or ":" in parts[1]):
                        ip = parts[0]
                        mac = parts[1].replace("-", ":").upper()
                        if len(mac) == 17:
                            arp_map[ip] = mac
            else:
                res = subprocess.run(["ip", "neigh", "show"], capture_output=True, text=True)
                for line in res.stdout.splitlines():
                    parts = line.split()
                    if len(parts) >= 5 and parts[3] == "lladdr":
                        ip = parts[0]
                        mac = parts[4].upper()
                        arp_map[ip] = mac
        except Exception:
            pass
    return arp_map


def get_local_interfaces() -> List[str]:
    """Lấy danh sách các địa chỉ IP của các card mạng đang hoạt động trên máy (Windows, Linux, macOS)."""
    ips = []
    # 1. Thử qua socket trước (chuẩn cross-platform: Windows, Linux, macOS)
    try:
        import socket
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    # 2. Bổ sung qua ip addr show trên Linux để quét thêm các subnet/VLAN
    try:
        import subprocess
        res = subprocess.run(["ip", "-o", "-4", "addr", "show"], capture_output=True, text=True)
        for line in res.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 4 and not parts[1].startswith("lo"):
                ip = parts[3].split("/")[0]
                if ip not in ips:
                    ips.append(ip)
    except Exception:
        pass

    if not ips:
        ips.append("0.0.0.0")
    return ips


def parse_target_ips(targets_str: str) -> List[str]:
    """
    Phân tích chuỗi địa chỉ IP đích:
    - Hỗ trợ CIDR: 192.168.20.0/24
    - Hỗ trợ dải IP: 192.168.20.1-192.168.20.100 hoặc 192.168.20.1-100
    - Hỗ trợ IP đơn lẻ: 192.168.20.50
    - Hỗ trợ phân cách bằng dấu phẩy: 192.168.20.0/24, 192.168.30.1-50, 10.0.1.25
    """
    import ipaddress
    ips = []
    for item in targets_str.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            if "/" in item:  # CIDR notation
                net = ipaddress.ip_network(item, strict=False)
                ips.extend([str(ip) for ip in net.hosts()])
            elif "-" in item:  # Range notation
                start_str, end_str = item.split("-", 1)
                start_str = start_str.strip()
                end_str = end_str.strip()
                if "." not in end_str:
                    prefix = ".".join(start_str.split(".")[:-1])
                    end_str = f"{prefix}.{end_str}"
                start_ip = ipaddress.IPv4Address(start_str)
                end_ip = ipaddress.IPv4Address(end_str)
                cur = start_ip
                while cur <= end_ip:
                    ips.append(str(cur))
                    cur += 1
            else:  # Single IP
                ips.append(str(ipaddress.IPv4Address(item)))
        except Exception as e:
            print(f"[!] Lỗi phân tích cú pháp dải IP '{item}': {e}")
    return list(dict.fromkeys(ips))  # Loại bỏ trùng lặp giữ thứ tự


def scan_onvif_devices(
    timeout: float = 2.5,
    bcast_ips: Optional[List[str]] = None,
    unicast_ips: Optional[List[str]] = None,
    verbose: bool = False
) -> Dict[str, Dict[str, Any]]:
    """
    Dò quét thiết bị camera chuẩn quốc tế ONVIF WS-Discovery (UDP port 3702).
    Hỗ trợ mọi thương hiệu: Hikvision, Ezviz, TP-Link Tapo, Tiandy, Uniview, Yoosee, Sony, Axis...
    """
    probe_id = str(uuid.uuid4())
    probe_msg = f"""<?xml version="1.0" encoding="utf-8"?>
<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope" xmlns:dn="http://www.onvif.org/ver10/network/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <Header>
    <wsa:MessageID xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">uuid:{probe_id}</wsa:MessageID>
    <wsa:To xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>
    <wsa:Action xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>
  </Header>
  <Body>
    <Probe xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery">
      <Types>dn:NetworkVideoTransmitter tds:Device</Types>
    </Probe>
  </Body>
</Envelope>""".encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024 * 1024)
    except Exception:
        pass

    try:
        sock.bind(("0.0.0.0", 0))
    except Exception:
        pass

    targets = [("239.255.255.250", 3702), ("255.255.255.255", 3702)]
    if bcast_ips:
        for b in bcast_ips:
            targets.append((b, 3702))

    for t in targets:
        try:
            sock.sendto(probe_msg, t)
        except Exception:
            pass

    if unicast_ips:
        for u in unicast_ips:
            try:
                sock.sendto(probe_msg, (u, 3702))
            except Exception:
                pass

    found: Dict[str, Dict[str, Any]] = {}
    sock.settimeout(0.15)
    start_time = time.time()

    while time.time() - start_time < timeout:
        try:
            data, addr = sock.recvfrom(65535)
            sender_ip = addr[0]
            xml_text = data.decode("utf-8", errors="ignore")

            # 1. Trích xuất XAddrs (URL dịch vụ và địa chỉ IP thực)
            xaddrs = re.findall(r"<[^:>]*:?XAddrs>([^<]+)</[^:>]*:?XAddrs>", xml_text)
            actual_ip = sender_ip
            http_port = 80
            onvif_path = "/onvif/device_service"

            if xaddrs:
                urls = xaddrs[0].strip().split()
                if urls:
                    p = urllib.parse.urlparse(urls[0])
                    if p.hostname and not p.hostname.startswith("127."):
                        actual_ip = p.hostname
                    if p.port:
                        http_port = p.port
                    if p.path:
                        onvif_path = p.path

            # 2. Trích xuất Scopes (Tên, Phần cứng, Vị trí)
            scopes_match = re.findall(r"<[^:>]*:?Scopes>([^<]+)</[^:>]*:?Scopes>", xml_text)
            scopes = []
            if scopes_match:
                scopes = scopes_match[0].strip().split()

            dev_name = ""
            dev_hardware = ""
            dev_location = ""
            for s in scopes:
                if "/name/" in s:
                    dev_name = urllib.parse.unquote(s.split("/name/")[-1])
                elif "/hardware/" in s:
                    dev_hardware = urllib.parse.unquote(s.split("/hardware/")[-1])
                elif "/location/" in s:
                    dev_location = urllib.parse.unquote(s.split("/location/")[-1])

            # 3. Phân loại Vendor thông minh
            vendor = "ONVIF"
            low_text = xml_text.lower()
            low_hw = dev_hardware.lower()
            low_name = dev_name.lower()

            if "hikvision" in low_text or "hikvision" in low_hw or "ds-2c" in low_hw or "hik" in low_name:
                vendor = "Hikvision"
            elif "ezviz" in low_text or "ezviz" in low_hw or "c6n" in low_hw or "c3w" in low_hw or "c8c" in low_hw:
                vendor = "Ezviz"
            elif "tapo" in low_text or "tp-link" in low_text or "tapo" in low_name or "c200" in low_hw or "c310" in low_hw:
                vendor = "TP-Link Tapo"
            elif "uniview" in low_text or "unv" in low_text or "uniview" in low_hw:
                vendor = "Uniview"
            elif "tiandy" in low_text or "tiandy" in low_hw:
                vendor = "Tiandy"
            elif "dahua" in low_text or "imou" in low_text or "lechange" in low_text or dev_name in ["LC", "Lechange"]:
                vendor = "Dahua/Imou"
            elif "yoosee" in low_text or "yoosee" in low_name:
                vendor = "Yoosee"
            elif "kbvision" in low_text or "kbvision" in low_hw:
                vendor = "KBVision"

            # Tách Model và Serial
            model = dev_hardware or "ONVIF IP Camera"
            serial = ""
            if "_" in dev_hardware:
                parts = dev_hardware.split("_", 1)
                model = parts[0]
                serial = parts[1]

            octets = actual_ip.split(".")
            vlan_num = octets[2] if len(octets) >= 3 else "0"

            found[actual_ip] = {
                "ip": actual_ip,
                "name": dev_name or f"{vendor} Camera",
                "model": model,
                "class": "NVR" if "NVR" in model.upper() else "IPC",
                "mac": "",
                "serial": serial,
                "firmware": "",
                "http_port": http_port,
                "tcp_port": 8000 if vendor in ["Hikvision", "Ezviz"] else 37777 if vendor in ["Dahua/Imou", "KBVision"] else 554,
                "rtsp_port": 554,
                "gateway": "",
                "netmask": "",
                "dhcp": "N/A",
                "vendor": vendor,
                "init_state": 1,
                "vlan": f"VLAN {vlan_num}",
                "vlan_id": vlan_num,
                "status": "Online",
                "is_solar": False,
                "onvif_service": onvif_path,
                "discovery_proto": "ONVIF WS-Discovery",
                "raw_info": {"scopes": scopes, "xaddrs": xaddrs}
            }
        except socket.timeout:
            continue
        except Exception:
            break

    sock.close()
    return found


def scan_sadp_devices(
    timeout: float = 2.0,
    bcast_ips: Optional[List[str]] = None,
    unicast_ips: Optional[List[str]] = None,
    verbose: bool = False
) -> Dict[str, Dict[str, Any]]:
    """
    Dò quét thiết bị Hikvision / Ezviz bằng giao thức SADP chuyên biệt (UDP port 37020).
    Hoạt động ngay cả khi camera chưa kích hoạt tính năng ONVIF.
    """
    sadp_uuid = str(uuid.uuid4()).upper()
    sadp_msg = f'<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>{sadp_uuid}</Uuid><Types>inquiry</Types></Probe>'.encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("0.0.0.0", 0))
    except Exception:
        pass

    targets = [("239.255.255.250", 37020), ("255.255.255.255", 37020)]
    if bcast_ips:
        for b in bcast_ips:
            targets.append((b, 37020))

    for t in targets:
        try:
            sock.sendto(sadp_msg, t)
        except Exception:
            pass

    if unicast_ips:
        for u in unicast_ips:
            try:
                sock.sendto(sadp_msg, (u, 37020))
            except Exception:
                pass

    found: Dict[str, Dict[str, Any]] = {}
    sock.settimeout(0.15)
    start_time = time.time()

    while time.time() - start_time < timeout:
        try:
            data, addr = sock.recvfrom(65535)
            sender_ip = addr[0]
            xml_text = data.decode("utf-8", errors="ignore")

            if "<ProbeMatch>" not in xml_text:
                continue

            def get_tag(tag: str, default: str = "") -> str:
                m = re.search(rf"<{tag}>([^<]+)</{tag}>", xml_text)
                return m.group(1).strip() if m else default

            actual_ip = get_tag("IPv4Address", sender_ip)
            dev_model = get_tag("DeviceDescription") or get_tag("DeviceType", "Hikvision Camera")
            serial = get_tag("DeviceSN", "")
            mac = get_tag("MAC", "").upper().replace("-", ":")
            firmware = get_tag("SoftwareVersion", "")
            http_port = int(get_tag("HttpPort", "80") or 80)
            cmd_port = int(get_tag("CommandPort", "8000") or 8000)
            gateway = get_tag("IPv4Gateway", "")
            netmask = get_tag("IPv4SubnetMask", "")

            # Phân loại Ezviz vs Hikvision
            low_desc = dev_model.lower()
            vendor = "Ezviz" if ("ezviz" in low_desc or "c6n" in low_desc or "c3w" in low_desc or "c8c" in low_desc) else "Hikvision"

            octets = actual_ip.split(".")
            vlan_num = octets[2] if len(octets) >= 3 else "0"

            found[actual_ip] = {
                "ip": actual_ip,
                "name": f"{vendor} {dev_model}",
                "model": dev_model,
                "class": "NVR" if "NVR" in dev_model.upper() else "IPC",
                "mac": mac,
                "serial": serial,
                "firmware": firmware,
                "http_port": http_port,
                "tcp_port": cmd_port,
                "rtsp_port": 554,
                "gateway": gateway,
                "netmask": netmask,
                "dhcp": "N/A",
                "vendor": vendor,
                "init_state": 1,
                "vlan": f"VLAN {vlan_num}",
                "vlan_id": vlan_num,
                "status": "Online",
                "is_solar": False,
                "discovery_proto": "Hikvision SADP",
                "raw_info": {"xml": xml_text}
            }
        except socket.timeout:
            continue
        except Exception:
            break

    sock.close()
    return found


def scan_devices(
    timeout: float = 3.0,
    deep_scan: bool = True,
    custom_targets: Optional[List[str]] = None,
    verbose: bool = False
) -> List[Dict[str, Any]]:
    """
    Quét tìm TẤT CẢ các thiết bị camera đa thương hiệu (Imou, Dahua, Hikvision, Ezviz, TP-Link Tapo, Uniview, Tiandy, Yoosee, ONVIF...)
    chạy đồng thời 3 giao thức dò quét chuyên sâu:
    1. Dahua / Imou DHDiscover & DVRIP (UDP 37810, 5050)
    2. Chuẩn quốc tế ONVIF WS-Discovery (UDP 3702)
    3. Hikvision SADP Protocol (UDP 37020)
    """
    local_ips = get_local_interfaces()

    # Tính toán danh sách broadcast và unicast
    broadcast_ips: List[str] = ["255.255.255.255"]
    for ip in local_ips:
        octets = ip.split(".")
        if len(octets) == 4 and not ip.startswith("127."):
            broadcast_ips.append(f"{octets[0]}.{octets[1]}.{octets[2]}.255")

    unicast_targets: List[str] = []
    if custom_targets:
        unicast_targets = list(custom_targets)
        for tip in custom_targets:
            parts = tip.split(".")
            if len(parts) == 4:
                sub_bcast = f"{parts[0]}.{parts[1]}.{parts[2]}.255"
                if sub_bcast not in broadcast_ips:
                    broadcast_ips.append(sub_bcast)
    elif deep_scan:
        for ip in local_ips:
            octets = ip.split(".")
            if len(octets) == 4 and not ip.startswith("127."):
                prefix = f"{octets[0]}.{octets[1]}.{octets[2]}"
                for host in range(1, 255):
                    unicast_targets.append(f"{prefix}.{host}")

    dahua_results: Dict[str, Dict[str, Any]] = {}
    onvif_results: Dict[str, Dict[str, Any]] = {}
    sadp_results: Dict[str, Dict[str, Any]] = {}

    def run_dahua_scan():
        nonlocal dahua_results
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 2 * 1024 * 1024)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 2 * 1024 * 1024)
        except Exception:
            pass

        try:
            sock.bind(("0.0.0.0", DISCOVER_PORT))
        except Exception:
            sock.bind(("0.0.0.0", 0))

        probe_multicast = build_probe_packet("DHDiscover.search", {"mac": "", "uni": 1})
        probe_client = json.dumps({"method": "client.search", "params": {"mac": ""}}).encode("utf-8")
        probe_dvrip = struct.pack(">I", 0xa3010001) + b"\x00" * 12 + struct.pack(">I", 0x02000000) + b"\x00" * 12
        wol_packet = b"\xff" * 102

        dahua_targets = [(MULTICAST_GROUP, DISCOVER_PORT), ("255.255.255.255", DISCOVER_PORT)]
        for b_ip in broadcast_ips:
            dahua_targets.append((b_ip, DISCOVER_PORT))

        def send_dahua_probes(include_unicast: bool = True):
            for b_ip, _ in dahua_targets:
                try:
                    sock.sendto(wol_packet, (b_ip, 9))
                    sock.sendto(wol_packet, (b_ip, DISCOVER_PORT))
                except Exception:
                    pass
            for target in dahua_targets:
                try:
                    sock.sendto(probe_multicast, target)
                    sock.sendto(probe_client, target)
                    sock.sendto(probe_dvrip, target)
                    sock.sendto(probe_dvrip, (target[0], 5050))
                except Exception:
                    pass
            if include_unicast:
                for u_ip in unicast_targets:
                    try:
                        sock.sendto(probe_multicast, (u_ip, DISCOVER_PORT))
                        sock.sendto(probe_client, (u_ip, DISCOVER_PORT))
                    except Exception:
                        pass

        send_dahua_probes(include_unicast=True)
        sock.settimeout(0.12)
        local_ips_set = set(local_ips)
        start_t = time.time()
        burst_count = 1
        last_burst_t = start_t

        while time.time() - start_t < timeout:
            now = time.time()
            if now - last_burst_t > 0.8 and burst_count < 3:
                burst_count += 1
                last_burst_t = now
                send_dahua_probes(include_unicast=(burst_count == 2))
            try:
                data, addr = sock.recvfrom(65535)
                sender_ip = addr[0]
                if sender_ip in local_ips_set or sender_ip == "127.0.0.1":
                    continue
                parsed = parse_device_packet(data)
                if not parsed:
                    continue

                params = parsed.get("params", {})
                dev_info = params.get("deviceInfo", params)
                mac = parsed.get("mac") or dev_info.get("mac") or ""
                serial = dev_info.get("SerialNo") or ""

                ipv4 = dev_info.get("IPv4Address", {})
                current_ip = ipv4.get("IPAddress") or sender_ip
                gateway = ipv4.get("DefaultGateway", "")
                netmask = ipv4.get("SubnetMask", "")
                dhcp = ipv4.get("DhcpEnable", None)

                octets = current_ip.split(".")
                vlan_num = octets[2] if len(octets) >= 3 else "0"
                vlan_label = f"VLAN {vlan_num}"

                model_name = dev_info.get("DeviceType", "N/A")
                # Chỉ suy luận từ dữ liệu thiết bị thật (model/name), không dựa vào IP hardcode.
                is_solar = ("Solar" in model_name or "K9D" in model_name or "Cell" in model_name)

                device_data = {
                    "ip": current_ip,
                    "name": dev_info.get("MachineName", "N/A"),
                    "model": model_name,
                    "class": dev_info.get("DeviceClass", "IPC"),
                    "mac": mac.upper(),
                    "serial": serial,
                    "firmware": dev_info.get("Version", "N/A"),
                    "http_port": dev_info.get("HttpPort", 80),
                    "tcp_port": dev_info.get("Port", 37777),
                    "gateway": gateway,
                    "netmask": netmask,
                    "dhcp": "DHCP" if dhcp else "Static" if dhcp is False else "N/A",
                    "vendor": dev_info.get("Vendor", "Dahua/Imou"),
                    "init_state": dev_info.get("Init", 0),
                    "vlan": vlan_label,
                    "vlan_id": vlan_num,
                    "status": "Online",
                    "is_solar": is_solar,
                    "discovery_proto": "Dahua DHIP",
                    "raw_info": dev_info
                }
                if current_ip in dahua_results:
                    if dahua_results[current_ip].get("mac") and not mac:
                        continue
                dahua_results[current_ip] = device_data
            except socket.timeout:
                continue
            except Exception:
                break
        sock.close()

    def run_onvif_scan():
        nonlocal onvif_results
        try:
            onvif_results = scan_onvif_devices(
                timeout=timeout,
                bcast_ips=broadcast_ips,
                unicast_ips=unicast_targets if deep_scan else None,
                verbose=verbose
            )
        except Exception as e:
            if verbose:
                print(f"[!] Lỗi scan ONVIF: {e}")

    def run_sadp_scan():
        nonlocal sadp_results
        try:
            sadp_results = scan_sadp_devices(
                timeout=timeout * 0.85,
                bcast_ips=broadcast_ips,
                unicast_ips=unicast_targets if deep_scan else None,
                verbose=verbose
            )
        except Exception as e:
            if verbose:
                print(f"[!] Lỗi scan SADP: {e}")

    # Chạy đồng thời 3 luồng dò quét trên 3 giao thức mạng
    t_dahua = threading.Thread(target=run_dahua_scan, daemon=True)
    t_onvif = threading.Thread(target=run_onvif_scan, daemon=True)
    t_sadp = threading.Thread(target=run_sadp_scan, daemon=True)

    t_dahua.start()
    t_onvif.start()
    t_sadp.start()

    t_dahua.join(timeout + 0.5)
    t_onvif.join(timeout + 0.5)
    t_sadp.join(timeout + 0.5)

    # Hợp nhất kết quả từ 3 nguồn dò quét (Ưu tiên Dahua cho thiết bị Dahua, bổ sung Hikvision/ONVIF)
    devices_dict: Dict[str, Dict[str, Any]] = dict(dahua_results)

    # Bổ sung kết quả Hikvision SADP
    for ip, dev in sadp_results.items():
        if ip not in devices_dict:
            devices_dict[ip] = dev
        else:
            # Bổ sung MAC hoặc Firmware nếu bên Dahua thiếu
            if not devices_dict[ip].get("mac") and dev.get("mac"):
                devices_dict[ip]["mac"] = dev["mac"]
            if not devices_dict[ip].get("firmware") and dev.get("firmware"):
                devices_dict[ip]["firmware"] = dev["firmware"]

    # Bổ sung kết quả ONVIF WS-Discovery
    for ip, dev in onvif_results.items():
        if ip not in devices_dict:
            devices_dict[ip] = dev
        else:
            devices_dict[ip]["onvif_supported"] = True
            if dev.get("onvif_service"):
                devices_dict[ip]["onvif_service"] = dev["onvif_service"]
            if not devices_dict[ip].get("serial") and dev.get("serial"):
                devices_dict[ip]["serial"] = dev["serial"]

    # Tra cứu bảng ARP để điền MAC cho các camera ONVIF chưa có MAC
    arp_map = get_arp_table()
    for ip, dev in devices_dict.items():
        if not dev.get("mac") and ip in arp_map:
            dev["mac"] = arp_map[ip]

    return list(devices_dict.values())


def detect_company_vlans(vlans: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """Ping gateway của các VLAN do cấu hình ``settings.company_vlans`` cung cấp.

    Không còn danh mục hardcode trong source: label/subnet là dữ liệu cấu hình
    theo từng môi trường và được validate ở tầng settings của ``app.py``.
    """
    from concurrent.futures import ThreadPoolExecutor
    import ipaddress
    import subprocess

    import sys

    configured: List[Dict[str, str]] = []
    for item in vlans or []:
        if not isinstance(item, dict):
            continue
        subnet = str(item.get("subnet") or "").strip()
        try:
            network = ipaddress.ip_network(subnet, strict=False)
        except ValueError:
            continue
        if network.version != 4 or not network.is_private:
            continue
        configured.append({
            "vlan": str(item.get("vlan") or "").strip()[:16],
            "subnet": str(network),
            "label": str(item.get("label") or "").strip()[:64],
            "gateway_ip": str(next(network.hosts(), network.network_address)),
        })

    def check_gw(vlan_info):
        gw_ip = vlan_info["gateway_ip"]
        try:
            if sys.platform == "win32":
                res = subprocess.run(["ping", "-n", "1", "-w", "400", gw_ip], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                res = subprocess.run(["ping", "-c", "1", "-W", "0.4", gw_ip], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            is_up = (res.returncode == 0)
        except Exception:
            is_up = False
        return {
            "vlan": vlan_info["vlan"],
            "subnet": vlan_info["subnet"],
            "label": vlan_info["label"],
            "gateway": gw_ip,
            "is_up": is_up,
        }

    if not configured:
        return []
    with ThreadPoolExecutor(max_workers=10) as ex:
        return list(ex.map(check_gw, configured))


def print_devices_rich(devices: List[Dict[str, Any]]) -> None:
    """Hiển thị bảng danh sách thiết bị bằng thư viện rich đẹp mắt."""
    import shutil
    from rich.console import Console
    from rich.table import Table
    from rich import box

    term_cols = shutil.get_terminal_size((150, 24)).columns
    actual_width = max(term_cols, 150)
    console = Console(_environ={"COLUMNS": str(actual_width)})
    table = Table(
        title="🔍 DANH SÁCH THIẾT BỊ IMOU / DAHUA TRONG MẠNG LAN",
        box=box.ROUNDED,
        header_style="bold cyan",
        title_style="bold green"
    )

    table.add_column("#", justify="right", style="dim")
    table.add_column("Địa chỉ IP", style="bold green", justify="left", no_wrap=True)
    table.add_column("Tên thiết bị", style="cyan")
    table.add_column("Model", style="yellow", no_wrap=True)
    table.add_column("Loại", style="magenta", justify="center")
    table.add_column("Địa chỉ MAC", style="blue", no_wrap=True)
    table.add_column("Serial (SN)", style="white", no_wrap=True)
    table.add_column("HTTP / TCP", justify="center", no_wrap=True)
    table.add_column("DHCP", justify="center")
    table.add_column("Firmware", style="dim", no_wrap=True)

    for idx, d in enumerate(devices, 1):
        port_str = f"{d['http_port']} / {d['tcp_port']}"
        table.add_row(
            str(idx),
            d["ip"],
            d["name"],
            d["model"],
            d["class"],
            d["mac"],
            d["serial"],
            port_str,
            d["dhcp"],
            d["firmware"]
        )

    console.print()
    console.print(table)
    console.print(f"[bold green]✓ Tìm thấy tổng cộng: {len(devices)} thiết bị.[/bold green]\n")


def print_devices_plain(devices: List[Dict[str, Any]]) -> None:
    """Hiển thị bảng bằng text thuần nếu không có thư viện rich."""
    print(f"\n{'#':<3} {'IP Address':<16} {'Device Name':<20} {'Model':<18} {'MAC':<18} {'Serial':<18} {'Ports':<12}")
    print("-" * 110)
    for idx, d in enumerate(devices, 1):
        ports = f"{d['http_port']}/{d['tcp_port']}"
        print(f"{idx:<3} {d['ip']:<16} {d['name']:<20} {d['model']:<18} {d['mac']:<18} {d['serial']:<18} {ports:<12}")
    print("-" * 110)
    print(f"Tổng cộng: {len(devices)} thiết bị.\n")


def main():
    parser = argparse.ArgumentParser(
        description="Quét tìm camera Imou / Dahua trong mạng LAN hoặc Liên VLAN (khác Subnet)."
    )
    parser.add_argument("-s", "--subnet", "--subnets", type=str, help="Dải mạng / VLAN cần quét (VD: 192.168.20.0/24 hoặc 192.168.20.0/24,192.168.30.0/24)")
    parser.add_argument("-r", "--range", type=str, help="Khoảng IP cần quét (VD: 192.168.20.1-254 hoặc 192.168.20.10-50)")
    parser.add_argument("--ip", "--ips", type=str, help="IP cụ thể hoặc danh sách IP phân cách bởi dấu phẩy")
    parser.add_argument("-m", "--model", type=str, help="Lọc theo tên model (ví dụ: A22, F22, K2M, Cruiser...)")
    parser.add_argument("-t", "--timeout", type=float, default=3.0, help="Thời gian quét (giây), mặc định: 3.0s")
    parser.add_argument("--no-deep", action="store_true", help="Tắt chế độ quét sâu unicast subnet (chỉ dùng cho LAN cục bộ)")
    parser.add_argument("-j", "--json", action="store_true", help="Xuất kết quả định dạng JSON")
    parser.add_argument("-o", "--output", type=str, help="Lưu kết quả ra file (.json hoặc .csv)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Hiển thị chi tiết log lỗi")

    args = parser.parse_args()

    # Thu thập các mục tiêu quét liên VLAN nếu có
    custom_targets = []
    target_inputs = []
    if args.subnet:
        target_inputs.append(args.subnet)
    if args.range:
        target_inputs.append(args.range)
    if args.ip:
        target_inputs.append(args.ip)

    if target_inputs:
        combined_target_str = ",".join(target_inputs)
        custom_targets = parse_target_ips(combined_target_str)
        if not custom_targets:
            print("[!] Không tìm thấy IP hợp lệ nào từ tham số đầu vào.")
            sys.exit(1)

    if not args.json:
        if custom_targets:
            print(f"[*] Đang quét liên VLAN / IP chỉ định ({len(custom_targets)} địa chỉ IP, timeout: {args.timeout}s)...")
        else:
            deep_text = " (quét sâu Unicast + Multicast)" if not args.no_deep else " (chỉ Multicast)"
            print(f"[*] Đang quét thiết bị Imou / Dahua trong mạng LAN{deep_text}...")

    devices = scan_devices(
        timeout=args.timeout,
        deep_scan=not args.no_deep,
        custom_targets=custom_targets if custom_targets else None,
        verbose=args.verbose
    )

    # Lọc theo model nếu có tham số -m
    if args.model:
        query = args.model.lower()
        devices = [d for d in devices if query in d["model"].lower() or query in d["name"].lower()]

    # Sắp xếp theo IP
    try:
        devices.sort(key=lambda x: [int(p) for p in x["ip"].split(".")])
    except Exception:
        pass

    if args.json:
        # Không in bảng nếu người dùng yêu cầu raw json
        clean_devices = [{k: v for k, v in d.items() if k != "raw_info"} for d in devices]
        print(json.dumps(clean_devices, indent=2, ensure_ascii=False))
    else:
        try:
            print_devices_rich(devices)
        except ImportError:
            print_devices_plain(devices)

    # Lưu file nếu có tham số -o
    if args.output:
        if args.output.endswith(".json"):
            clean_devices = [{k: v for k, v in d.items() if k != "raw_info"} for d in devices]
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(clean_devices, f, indent=2, ensure_ascii=False)
            print(f"[+] Đã lưu kết quả JSON vào: {args.output}")
        elif args.output.endswith(".csv"):
            keys = ["ip", "name", "model", "class", "mac", "serial", "http_port", "tcp_port", "gateway", "netmask", "dhcp", "firmware", "vendor"]
            with open(args.output, "w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=keys)
                writer.writeheader()
                for d in devices:
                    row = {k: d.get(k, "") for k in keys}
                    writer.writerow(row)
            print(f"[+] Đã lưu kết quả CSV vào: {args.output}")
        else:
            print(f"[!] Định dạng file {args.output} không hỗ trợ (chỉ hỗ trợ .json hoặc .csv)")


if __name__ == "__main__":
    main()
