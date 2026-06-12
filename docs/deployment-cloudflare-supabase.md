# Cloudflare Pages 與 Supabase 部署指南

## 1. Supabase

### 建立資料表

在 Supabase SQL Editor 執行：

```sql
-- supabase/migrations/20260612000000_create_lotto_tables.sql
```

或使用 Supabase CLI：

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

### 匯入現有資料

本機或 GitHub Actions 皆可執行：

```bash
python scripts/sync_supabase.py
```

必要環境變數：

```bash
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

`service_role` 只用於後端同步資料，不可放到前端。

## 2. Cloudflare Pages

建議用本 repo 的 GitHub Actions workflow 部署：

```text
.github/workflows/deploy_cloudflare_pages.yml
```

Cloudflare Pages project name 預設為：

```text
lotto-predictions
```

若 Cloudflare Pages 專案名稱不同，請設定 GitHub Repository Variable：

```text
CLOUDFLARE_PROJECT_NAME=<your-pages-project-name>
```

## 3. GitHub Secrets / Variables

### Secrets

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ANON_KEY
```

### Variables，可選

```text
CLOUDFLARE_PROJECT_NAME
SUPABASE_URL
SUPABASE_ANON_KEY
```

前端建置會讀：

```text
VITE_BASE_PATH=/
VITE_SUPABASE_URL=<SUPABASE_URL>
VITE_SUPABASE_ANON_KEY=<SUPABASE_ANON_KEY>
```

如果 Supabase 尚未匯入資料，前端會自動 fallback 到靜態 JSON：

```text
/data/meta.json
/data/predictions.json
/data/lotto649.json
/data/daily539.json
/data/performance.json
```

## 4. 自訂網域

在 Cloudflare Dashboard：

1. 進入 Workers & Pages。
2. 選取 `lotto-predictions` Pages project。
3. 進入 Custom domains。
4. 加入你的付費網域或子網域。
5. 確認 DNS 由 Cloudflare 管理，並等待憑證與 DNS 生效。

## 5. 驗證

部署完成後檢查：

```bash
curl -I https://<your-domain>/
curl https://<your-domain>/data/meta.json
```

如果 Supabase 已設定，瀏覽器 DevTools Network 應可看到：

```text
https://<your-project-ref>.supabase.co/rest/v1/app_meta
https://<your-project-ref>.supabase.co/rest/v1/lotto_draws
https://<your-project-ref>.supabase.co/rest/v1/prediction_records
```
