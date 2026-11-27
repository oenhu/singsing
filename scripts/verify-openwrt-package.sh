#!/bin/sh
set -eu

package="${1:?usage: verify-openwrt-package.sh PACKAGE [SDK_APK]}"
sdk_apk="${2:-apk}"
source_dir="$(CDPATH= cd "$(dirname "$0")/.." && pwd)"
version="$(awk -F ':=' '/^PKG_VERSION:=/ {print $2; exit}' "$source_dir/Makefile")"
release="$(awk -F ':=' '/^PKG_RELEASE:=/ {print $2; exit}' "$source_dir/Makefile")"
expected_version="$version-r$release"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/control" "$work/files"

case "$package" in
	*.ipk)
		tar -xOf "$package" ./control.tar.gz > "$work/control.tgz"
		tar -xzf "$work/control.tgz" -C "$work/control"
		tar -xOf "$package" ./data.tar.gz > "$work/data.tgz"
		tar -xzf "$work/data.tgz" -C "$work/files"
		meta="$work/control/control"
		grep -qx 'Package: luci-app-singsing' "$meta"
		grep -Fxq "Version: $expected_version" "$meta"
		grep -qx 'Architecture: all' "$meta"
		grep -qx '/etc/config/singsing' "$work/control/conffiles"
		sed -n 's/^Depends: //p' "$meta" | tr ', ' '\n' > "$work/depends"
		install_hook="$work/control/postinst-pkg"
		remove_hook="$work/control/prerm-pkg"
		postrm_hook="$work/control/postrm"
		sh -n "$work/control/postinst"
		sh -n "$work/control/prerm"
		sh -n "$postrm_hook"
		# Verify every entry in data.tar.gz and control.tar.gz is owned by 0/0 (root:root)
		for archive in "$work/data.tgz" "$work/control.tgz"; do
			bad_owners="$(tar -tzvf "$archive" --numeric-owner | awk '
				$2 == "0/0" { next }
				$2 ~ /^[0-9]+$/ && $3 == "0" && $4 == "0" { next }
				{ print }
			')"
			if [ -n "$bad_owners" ]; then
				printf 'Non-root UID/GID found in %s (%s):\n%s\n' "$package" "$(basename "$archive")" "$bad_owners" >&2
				exit 1
			fi
		done
		;;
	*.apk)
		"$sdk_apk" adbdump "$package" > "$work/metadata"
		meta="$work/metadata"
		grep -qx '  name: luci-app-singsing' "$meta"
		grep -Fxq "  version: $expected_version" "$meta"
		grep -qx '  arch: noarch' "$meta"
		awk '
			/^  depends:/ { active = 1; next }
			active && /^    - / { print $2; next }
			active { exit }
		' "$meta" > "$work/depends"
		# Verify every file/directory ACL in APK metadata uses user: root and group: root
		bad_apk_owners="$(awk '
			/^[[:space:]]+user:[[:space:]]*/ && $2 != "root" { print }
			/^[[:space:]]+group:[[:space:]]*/ && $2 != "root" { print }
		' "$meta")"
		if [ -n "$bad_apk_owners" ]; then
			printf 'Non-root owner found in APK metadata (%s):\n%s\n' "$package" "$bad_apk_owners" >&2
			exit 1
		fi
		"$sdk_apk" extract --allow-untrusted --destination "$work/files" "$package"
		for hook in post-install post-upgrade pre-deinstall post-deinstall; do
			awk -v hook="$hook" '
				$1 == hook ":" && $2 == "|" { active = 1; next }
				active && /^    / { print substr($0, 5); next }
				active { exit }
			' "$meta" > "$work/control/$hook"
			test -s "$work/control/$hook"
			sh -n "$work/control/$hook"
		done
		install_hook="$work/control/post-install"
		remove_hook="$work/control/pre-deinstall"
		postrm_hook="$work/control/post-deinstall"
		;;
	*) printf 'Unsupported OpenWrt package: %s\n' "$package" >&2; exit 1 ;;
esac

if [ -n "$(find "$work/files" -name '._*' -print -quit)" ]; then
	printf 'Unexpected AppleDouble metadata in package payload\n' >&2
	exit 1
fi

for dependency in libc luci-base rpcd rpcd-mod-ucode ucode ucode-mod-fs ucode-mod-uci \
	kmod-tun kmod-nft-tproxy kmod-nft-queue kmod-nft-nat firewall4 ca-bundle curl; do
	if ! grep -Fxq "$dependency" "$work/depends"; then
		printf 'Missing package dependency: %s\n' "$dependency" >&2
		exit 1
	fi
done

test -s "$install_hook"
test -s "$remove_hook"
test -s "$postrm_hook"
sh -n "$install_hook"
sh -n "$remove_hook"
sh -n "$postrm_hook"
grep -Fq '/etc/init.d/rpcd reload' "$install_hook"
grep -Fq '/etc/init.d/rpcd reload' "$postrm_hook"
for cleanup in '/etc/init.d/singsing stop' 'service-manager.sh dnsmasq_restore' \
	'service-manager.sh cron_remove' '/etc/init.d/singsing disable'; do
	grep -Fq "$cleanup" "$remove_hook"
done

for path in etc/init.d/singsing etc/hotplug.d/iface/95-singsing etc/uci-defaults/99-singsing usr/share/singsing/service-manager.sh; do
	test -x "$work/files/$path"
	sh -n "$work/files/$path"
	cmp "$source_dir/root/$path" "$work/files/$path"
done
for path in etc/config/singsing usr/share/rpcd/ucode/singsing.uc usr/share/rpcd/acl.d/luci-app-singsing.json; do
	cmp "$source_dir/root/$path" "$work/files/$path"
done
for path in luci-static/resources/singsing/api.js luci-static/resources/singsing/engine-bundle.js \
	luci-static/resources/view/singsing/settings.js; do
	cmp "$source_dir/htdocs/$path" "$work/files/www/$path"
done
printf 'Verified %s: version %s, dependencies, hooks and payload\n' "$package" "$expected_version"
