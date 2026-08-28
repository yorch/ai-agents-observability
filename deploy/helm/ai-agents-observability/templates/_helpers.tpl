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
Resolve S3 settings: external if set, otherwise bundled MinIO.
*/}}
{{- define "ai-agents-observability.s3Endpoint" -}}
{{- if .Values.externalS3.endpoint -}}
{{- .Values.externalS3.endpoint -}}
{{- else -}}
{{- printf "http://%s-minio:9000" (include "ai-agents-observability.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "ai-agents-observability.s3AccessKey" -}}
{{- if .Values.externalS3.endpoint -}}
{{- .Values.externalS3.accessKeyId -}}
{{- else -}}
{{- .Values.minio.auth.rootUser -}}
{{- end -}}
{{- end -}}

{{- define "ai-agents-observability.s3SecretKey" -}}
{{- if .Values.externalS3.endpoint -}}
{{- .Values.externalS3.secretAccessKey -}}
{{- else -}}
{{- .Values.minio.auth.rootPassword -}}
{{- end -}}
{{- end -}}

{{- define "ai-agents-observability.s3Bucket" -}}
{{- if .Values.externalS3.endpoint -}}
{{- .Values.externalS3.bucket -}}
{{- else -}}
{{- .Values.minio.bucket -}}
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
