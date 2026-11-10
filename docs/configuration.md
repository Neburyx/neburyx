# Configuration

The mapping file (the file `NEBURYX_CONFIG` names) holds the sources, their mappings and a few settings that belong to the deployment. This page lists the deployment settings. The sources and their mappings are described in [the domain packs](../domain-packs/README.md).

A setting that is out of range, of the wrong type or not known is refused when the API starts: the message names the key (for example `retention.deleted_investigations_days`), the API does not start and the exit code is 1.

## Retention

How long deleted things are kept. The block is optional, and so is each key in it.

```yaml
retention:
  deleted_investigations_days: 30
  exports_days: 7
```

| Key | Default | Range | What it sets |
|---|---|---|---|
| `retention.deleted_investigations_days` | 30 | 1 to 365 | How many days after a person deletes an investigation it can still be restored. The investigation leaves the ordinary lists at once and is listed under Deleted. When the days have passed it can no longer be restored, whether or not the daily clean-up has run, and the clean-up removes it with its draft and its named views. |
| `retention.exports_days` | 7 | 1 to 365 | How many days a file made by an export is kept. |

Changing a retention setting does not change any source, so saved work is not reported as made under another mapping. A change applies to what is deleted after the API restarts; an investigation that was already deleted keeps the purge date it was given.

A named view that a person deletes is not restorable. It is left out of every list and every count, and it is removed when its investigation is.
