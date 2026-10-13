This public certificate is Supabase Root 2021 CA. It is used only for database TLS connections to Supabase direct and shared pooler hosts; certificate and hostname verification remain enabled. Other HTTPS and database clients do not inherit it.

Official download: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

Supabase's dashboard links this URL through [custom-content.json](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json#L63) and [SSLConfiguration.tsx](https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/Settings/Database/SSLConfiguration.tsx#L123).

DER SHA-256: `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`.

Validity: April 28, 2021 through April 26, 2031. The helper verifies the fingerprint, CA flag, self-signature and validity before use. Updating this trust anchor requires verifying a new certificate against Supabase's official publication and reviewing its fingerprint.
