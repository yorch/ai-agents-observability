{{/*
Common helpers for the ai-agents-observability chart.
*/}}

{{- define "ai-agents-observability.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ai-agents-observability.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ai-agents-observability.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels
*/}}
{{- define "ai-agents-observability.labels" -}}
helm.sh/chart: {{ include "ai-agents-observability.chart" . }}
{{ include "ai-agents-observability.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels
*/}}
{{- define "ai-agents-observability.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-agents-observability.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Service account name
*/}}
{{- define "ai-agents-observability.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ai-agents-observability.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Resolve the image reference for a service.
Usage: {{ include "ai-agents-observability.image" (list . .Values.web.image) }}
*/}}
{{- define "ai-agents-observability.image" -}}
{{- $root := index . 0 -}}
{{- $svc := index . 1 -}}
{{- $registry := $root.Values.image.registry -}}
{{- $repository := $svc.repository -}}
{{- $tag := $svc.tag | default $root.Chart.AppVersion -}}
{{- printf "%s/%s:%s" $registry $repository $tag -}}
{{- end -}}

{{/*
Resolve pull policy for a service — falls back to global.
*/}}
{{- define "ai-agents-observability.pullPolicy" -}}
{{- $root := index . 0 -}}
{{- $svc := index . 1 -}}
{{- $svc.pullPolicy | default $root.Values.image.pullPolicy -}}
{{- end -}}

{{/*
Resolve the DATABASE_URL: external if set, otherwise bundled TimescaleDB.
*/}}
{{- define "ai-agents-observability.databaseUrl" -}}
{{- if .Values.externalDatabase.url -}}
{{- .Values.externalDatabase.url -}}
{{- else -}}
{{- printf "postgresql://%s:%s@%s-postgres:5432/%s" .Values.timescaledb.auth.username .Values.timescaledb.auth.password (include "ai-agents-observability.fullname" .) .Values.timescaledb.auth.database -}}
{{- end -}}
{{- end -}}

{{/*
Fail early on values that no longer mean anything. The bundled MinIO was
replaced by Garage (objectStore.*); a silently ignored minio.* block would
leave an install running with defaults the operator never chose.
*/}}
{{- define "ai-agents-observability.validate" -}}
{{- if hasKey .Values "minio" -}}
{{- fail "The minio.* values were removed: the bundled object store is now Garage under objectStore.* (set objectStore.enabled=false instead of minio.enabled=false). Existing MinIO data must be copied first; see docs/deploy/migrate-from-minio.md." -}}
{{- end -}}
{{- if and (not .Values.objectStore.enabled) (not .Values.externalS3.endpoint) -}}
{{- fail "objectStore.enabled=false requires externalS3.endpoint (and its credentials); otherwise ingest and web point at an object store that does not exist." -}}
{{- end -}}
{{- if and .Values.objectStore.enabled (not .Values.externalS3.endpoint) -}}
{{- if lt (len .Values.objectStore.auth.secretAccessKey) 16 -}}
{{- fail "objectStore.auth.secretAccessKey must be at least 16 characters (Garage refuses to start otherwise)." -}}
{{- end -}}
{{- /* Data-loss guard for upgrades from the MinIO chart. An install that kept
       the default values has no minio.* key to trip the check above, so the
       upgrade would delete the MinIO StatefulSet, start an EMPTY Garage, and
       leave every stored transcript in the orphaned PVC while /readyz is green.
       The PVC's presence is the signal. (lookup is empty under `helm template`,
       so this only fires against a live cluster, which is where it matters.) */ -}}
{{- $legacyPvc := printf "data-%s-minio-0" (include "ai-agents-observability.fullname" .) -}}
{{- if and (lookup "v1" "PersistentVolumeClaim" .Release.Namespace $legacyPvc) (not .Values.objectStore.legacyMinioPvcAcknowledged) -}}
{{- fail (printf "Found the PVC %s from the bundled MinIO this chart used to run. Upgrading would start an EMPTY Garage store while the database still references the transcripts in that PVC. Follow docs/deploy/migrate-from-minio.md, which has you set objectStore.legacyMinioPvcAcknowledged=true for the upgrade and then copy the data." $legacyPvc) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Resolve S3 settings: external if set, otherwise the bundled Garage store.
*/}}
{{- define "ai-agents-observability.s3Endpoint" -}}
{{- if .Values.externalS3.endpoint -}}
{{- .Values.externalS3.endpoint -}}
{{- else -}}
{{- printf "http://%s-object-store:9000" (include "ai-agents-observability.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "ai-agents-observability.s3AccessKey" -}}
{{- if .Values.externalS3.endpoint -}}
{{- .Values.externalS3.accessKeyId -}}
{{- else -}}
{{- .Values.objectStore.auth.accessKeyId -}}
{{- end -}}
{{- end -}}

{{- define "ai-agents-observability.s3SecretKey" -}}
{{- if .Values.externalS3.endpoint -}}
{{- .Values.externalS3.secretAccessKey -}}
{{- else -}}
{{- .Values.objectStore.auth.secretAccessKey -}}
{{- end -}}
{{- end -}}

{{- define "ai-agents-observability.s3Bucket" -}}
{{- if .Values.externalS3.endpoint -}}
{{- .Values.externalS3.bucket -}}
{{- else -}}
{{- .Values.objectStore.bucket -}}
{{- end -}}
{{- end -}}

{{- define "ai-agents-observability.s3Region" -}}
{{- if .Values.externalS3.endpoint -}}
{{- .Values.externalS3.region -}}
{{- else -}}
{{- "us-east-1" -}}
{{- end -}}
{{- end -}}

{{- define "ai-agents-observability.s3ForcePathStyle" -}}
{{- if .Values.externalS3.endpoint -}}
{{- .Values.externalS3.forcePathStyle -}}
{{- else -}}
{{- "true" -}}
{{- end -}}
{{- end -}}
