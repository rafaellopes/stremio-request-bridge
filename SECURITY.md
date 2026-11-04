# Security

If you find a vulnerability, please report it privately through GitHub's "Report a vulnerability" button on the Security tab of this repository instead of opening a public issue. You will get an answer within a few days.

Things that are expected behaviour rather than vulnerabilities:

- Anyone who knows the manifest URL (which contains `ACCESS_TOKEN`) can send requests, within the rate limits. Keep the URL private and rotate the token if it leaks.
