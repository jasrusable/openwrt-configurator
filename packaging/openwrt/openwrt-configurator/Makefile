#
# openwrt-configurator as an OpenWrt package: one architecture-independent
# JavaScript bundle run by QuickJS. Built by packaging/openwrt/build.sh, which
# copies the bundle into ./files first and sets PKG_VERSION.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=openwrt-configurator
PKG_VERSION?=0.0.0
PKG_RELEASE:=1

PKG_LICENSE:=AGPL-3.0-or-later
PKG_MAINTAINER:=Jason Russell <me@jasonrussell.io>

include $(INCLUDE_DIR)/package.mk

define Package/openwrt-configurator
  SECTION:=admin
  CATEGORY:=Administration
  TITLE:=Provision OpenWrt devices from one JSON network config
  URL:=https://github.com/jasrusable/openwrt-configurator
  DEPENDS:=+quickjs
  PKGARCH:=all
endef

define Package/openwrt-configurator/description
  Describe a whole network (devices, packages, UCI config and files) in one
  JSON file and provision it over SSH, with a commit-confirm rollback. Runs on
  the device itself, provisioning itself and the other devices it can reach,
  with its web UI at /cgi-bin/onc/ (log in with the root password).
  build-images additionally needs curl.
endef

define Build/Compile
endef

define Package/openwrt-configurator/conffiles
/etc/onc/
endef

define Package/openwrt-configurator/install
	$(INSTALL_DIR) $(1)/usr/share/openwrt-configurator
	$(INSTALL_DATA) ./files/openwrt-configurator.mjs $(1)/usr/share/openwrt-configurator/
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/openwrt-configurator $(1)/usr/bin/
	# The web UI, served by uhttpd at /cgi-bin/onc/ behind a login (the root password).
	$(INSTALL_DIR) $(1)/usr/share/openwrt-configurator/ui
	$(CP) ./files/ui/. $(1)/usr/share/openwrt-configurator/ui/
	$(INSTALL_DIR) $(1)/www/cgi-bin
	$(INSTALL_BIN) ./files/onc.cgi $(1)/www/cgi-bin/onc
	$(INSTALL_DIR) $(1)/etc/onc
	# What the Status pages show, read by a service of its own (the CGI only answers).
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/onc-collector.init $(1)/etc/init.d/onc-collector
endef

define Package/openwrt-configurator/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || { /etc/init.d/onc-collector enable; /etc/init.d/onc-collector start; }
exit 0
endef

define Package/openwrt-configurator/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || { /etc/init.d/onc-collector stop; /etc/init.d/onc-collector disable; }
exit 0
endef

$(eval $(call BuildPackage,openwrt-configurator))
