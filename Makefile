include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for sing-box (based on riverscn/singbox-confgen)
LUCI_DEPENDS:=+luci-base +rpcd +rpcd-mod-ucode +ucode +ucode-mod-fs +ucode-mod-uci +kmod-tun +kmod-nft-tproxy +kmod-nft-queue +kmod-nft-nat +firewall4 +ca-bundle +curl
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-singsing
PKG_VERSION:=0.1.0
PKG_RELEASE:=4
PKG_LICENSE:=MIT

define Package/$(PKG_NAME)/conffiles
/etc/config/singsing
/etc/singsing/
endef

define Package/$(PKG_NAME)/prerm
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	/etc/init.d/singsing stop >/dev/null 2>&1 || true
	/usr/share/singsing/service-manager.sh dnsmasq_restore >/dev/null 2>&1 || true
	/etc/init.d/singsing disable >/dev/null 2>&1 || true
	rm -rf /tmp/singsing /tmp/luci-indexcache* /tmp/luci-modulecache/* 2>/dev/null || true
fi
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
