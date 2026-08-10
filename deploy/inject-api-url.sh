#!/bin/sh

set -e

container_config_error() {
    echo "Container configuration error: $1" >&2
    exit 1
}

# 用环境变量替换前端默认 API URL
DEFAULT_API_URL=${DEFAULT_API_URL:-${API_URL:-https://api.openai.com/v1}}
DOCKER_LEGACY_API_URL_USED=${DOCKER_LEGACY_API_URL_USED:-false}
if [ "${SERVER_API_CONFIG_ENABLED:-false}" != "true" ] && [ -n "${API_URL:-}" ]
then
    DOCKER_LEGACY_API_URL_USED=true
fi
API_PROXY_AVAILABLE=false
if [ "$ENABLE_API_PROXY" = "true" ]
then
    API_PROXY_AVAILABLE=true
fi
API_PROXY_LOCKED=false
if [ "$ENABLE_API_PROXY" = "true" ] && [ "$LOCK_API_PROXY" = "true" ]
then
    API_PROXY_LOCKED=true
fi

# 所有动态字符串都已在 05-migrate-api-env.envsh 中限制为 JSON 安全字符；
# 布尔值、枚举和数字也经过严格校验。使用固定格式原子写入，避免任意 JSON 拼接。
RUNTIME_CONFIG_PATH=/usr/share/nginx/html/runtime-config.json
RUNTIME_CONFIG_TMP=${RUNTIME_CONFIG_PATH}.tmp
if [ "$RUNTIME_SERVER_API_ENABLED" = "true" ] && [ "$RUNTIME_RESTRICTED_AGENT_ENABLED" = "true" ]; then
    if ! printf '{\n  "version": 1,\n  "serverApi": {\n    "enabled": true,\n    "provider": "openai",\n    "model": "%s",\n    "apiMode": "%s",\n    "modelOptions": %s,\n    "apiModeOptions": %s,\n    "allowCustomModel": %s,\n    "codexCli": %s,\n    "responseFormatB64Json": %s,\n    "timeoutSeconds": %s,\n    "proxyPath": "/api-proxy"\n  },\n  "restrictedAgent": {\n    "enabled": true,\n    "basePath": "/agent-api/v1",\n    "agentOnly": %s\n  }\n}\n' \
        "$RUNTIME_SERVER_API_MODEL" \
        "$RUNTIME_SERVER_API_MODE" \
        "$RUNTIME_SERVER_API_MODEL_OPTIONS" \
        "$RUNTIME_SERVER_API_MODE_OPTIONS" \
        "$RUNTIME_SERVER_API_ALLOW_CUSTOM_MODEL" \
        "$RUNTIME_SERVER_API_CODEX_CLI" \
        "$RUNTIME_SERVER_API_RESPONSE_FORMAT_B64_JSON" \
        "$RUNTIME_SERVER_API_TIMEOUT_SECONDS" \
        "$RUNTIME_RESTRICTED_AGENT_ONLY" \
        2>/dev/null > "$RUNTIME_CONFIG_TMP"
    then
        container_config_error 'failed to write runtime configuration'
    fi
elif [ "$RUNTIME_SERVER_API_ENABLED" = "true" ]; then
    if ! printf '{\n  "version": 1,\n  "serverApi": {\n    "enabled": true,\n    "provider": "openai",\n    "model": "%s",\n    "apiMode": "%s",\n    "modelOptions": %s,\n    "apiModeOptions": %s,\n    "allowCustomModel": %s,\n    "codexCli": %s,\n    "responseFormatB64Json": %s,\n    "timeoutSeconds": %s,\n    "proxyPath": "/api-proxy"\n  }\n}\n' \
        "$RUNTIME_SERVER_API_MODEL" \
        "$RUNTIME_SERVER_API_MODE" \
        "$RUNTIME_SERVER_API_MODEL_OPTIONS" \
        "$RUNTIME_SERVER_API_MODE_OPTIONS" \
        "$RUNTIME_SERVER_API_ALLOW_CUSTOM_MODEL" \
        "$RUNTIME_SERVER_API_CODEX_CLI" \
        "$RUNTIME_SERVER_API_RESPONSE_FORMAT_B64_JSON" \
        "$RUNTIME_SERVER_API_TIMEOUT_SECONDS" \
        2>/dev/null > "$RUNTIME_CONFIG_TMP"
    then
        container_config_error 'failed to write runtime configuration'
    fi
elif [ "$RUNTIME_RESTRICTED_AGENT_ENABLED" = "true" ]; then
    if ! printf '{\n  "version": 1,\n  "serverApi": { "enabled": false },\n  "restrictedAgent": {\n    "enabled": true,\n    "basePath": "/agent-api/v1",\n    "agentOnly": %s\n  }\n}\n' \
        "$RUNTIME_RESTRICTED_AGENT_ONLY" \
        2>/dev/null > "$RUNTIME_CONFIG_TMP"
    then
        container_config_error 'failed to write runtime configuration'
    fi
elif ! printf '{\n  "version": 1,\n  "serverApi": { "enabled": false }\n}\n' \
    2>/dev/null > "$RUNTIME_CONFIG_TMP"
then
    container_config_error 'failed to write runtime configuration'
fi
if ! mv "$RUNTIME_CONFIG_TMP" "$RUNTIME_CONFIG_PATH" >/dev/null 2>&1; then
    container_config_error 'failed to publish runtime configuration'
fi

# 查找所有 js 文件并将占位符替换为运行时配置。
replace_asset_placeholder() {
    placeholder=$1
    replacement=$2
    if ! find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|$placeholder|$replacement|g" {} + >/dev/null 2>&1; then
        container_config_error 'failed to update frontend runtime placeholders'
    fi
}

replace_asset_placeholder '__VITE_DEFAULT_API_URL_PLACEHOLDER__' "$DEFAULT_API_URL"
replace_asset_placeholder '__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__' "$API_PROXY_AVAILABLE"
replace_asset_placeholder '__VITE_API_PROXY_LOCKED_PLACEHOLDER__' "$API_PROXY_LOCKED"
replace_asset_placeholder '__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__' 'true'
replace_asset_placeholder '__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__' "$DOCKER_LEGACY_API_URL_USED"
# 受限模式未启用时完全移除 Gateway 路由；缺失或非法开关不能意外暴露入口。
if [ "$RESTRICTED_AGENT_ENABLED" != "true" ]
then
    if ! sed -i '/# BEGIN RESTRICTED AGENT/,/# END RESTRICTED AGENT/d' /etc/nginx/conf.d/default.conf >/dev/null 2>&1; then
        container_config_error 'failed to apply restricted Agent configuration'
    fi
fi

# API proxy 只由显式开关决定；双能力部署需要同时保留 Chat 的受控代理和 Tool Gateway。
if [ "$ENABLE_API_PROXY" != "true" ]
then
    if ! sed -i '/# BEGIN API PROXY/,/# END API PROXY/d' /etc/nginx/conf.d/default.conf >/dev/null 2>&1; then
        container_config_error 'failed to apply API proxy configuration'
    fi
fi
if ! nginx -t >/dev/null 2>&1; then
    container_config_error 'generated Nginx configuration is invalid'
fi
exec "$@"
