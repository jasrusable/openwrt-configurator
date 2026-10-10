#
# openwrt-configurator as an OpenWrt package: one architecture-independent
# JavaScript bundle run by QuickJS. Built by packaging/openwrt/build.sh, which
# copies the bundle into ./files first and sets PKG_VERSION.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=openwrt-configurator
PKG_VERSION?=0.0.0
PKG_RELEASE:=1

PKG_LICENSE:=ISC
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
  the device itself, provisioning itself and the other devices it can reach.
  build-images additionally needs curl.
endef

define Build/Compile
endef

define Package/openwrt-configurator/install
	$(INSTALL_DIR) $(1)/usr/share/openwrt-configurator
	$(INSTALL_DATA) ./files/openwrt-configurator.mjs $(1)/usr/share/openwrt-configurator/
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/openwrt-configurator $(1)/usr/bin/
endef

$(eval $(call BuildPackage,openwrt-configurator))
