# Near-duplicates across all eight sources — a count, not a fix

Measured on 15 September 2026 from the cached pages of all eight sources (2,866 records,
2,716 rows after the folding `ingest/duplicates.py` already does). Nothing was merged.
Update of [the 14 September count](near-duplicates-2026-09-14.md), which covered five sources.

## The number

Two passes: names at ≥ 0.85 similarity once legal suffixes and generic words
(Technologies, Innovations, Labs…) are gone, and two rows giving the same website host.
34 candidate pairs; every one read by hand.

**18 pairs are very probably one company listed twice. 4 are uncertain. 12 are different
companies.** Almost all of the 18 arrive with the three sources added on 14 September.

| Pair | What gives it away | Sources |
|---|---|---|
| Ai Health Highway / Ai Health Highway India Pvt. Ltd. | same name, "India" added | FSID IISc / NM-ICPS |
| Brainhive Labs Pvt Ltd / Calibr (Brainhive Labs Pvt Ltd) | brand beside the company name; same site | NM-ICPS twice |
| Chainwork Digital / Chainworks Digital | one letter; both blockchain for organ transplants | SINE twice |
| Chigru Innovations (OPC) / Cradlewise Innovations | same website cradlewise.com, both a smart cradle | SINE / grants |
| Forensic Cybertech / Forensic Cybertech Machines | same site, same description | SINE / NM-ICPS + SINE |
| Ixar Robotic Solutions / Ixar Robotics | both underwater ROVs | SINE / NM-ICPS |
| Linearized Amplifier Technologies / … and Services | same name, words added | NM-ICPS / TIDES |
| Manastik Pvt Ltd / Manastik Technologies | same name | NM-ICPS / Venture Center |
| Module Innovation / Module Innovations | both rapid UTI diagnosis | NM-ICPS / Venture Center |
| Mythyaverse Pvt Ltd / Mythyaverse Innovation | both VR interview preparation | NM-ICPS twice |
| Open Water / Openwater.in | same site, both wastewater treatment | FSID / Venture Center |
| Seismic Hazard and Risk Investigations / Seismic Hazard & Risk Investigations | "and" / "&" | TIDES / grants |
| Stealthera / Stealthera Innovations | same name | NM-ICPS / DPIIT |
| Umarobotics / Umarobotics Technology | same name | TIDES / DPIIT + NM-ICPS |
| Vayunotics / Vayunotics Technologies | same name, both UAV avionics | DPIIT / NM-ICPS |
| Veritometrics / Veritometrics Technology | both the Drooid news platform | NM-ICPS / TIDES |
| Vidcare Innovations / Vidcare Technologies | both an equipment-free immunoassay test | TIDES / Venture Center |
| Arista Vault / Arivation Fashiontech (Arista Vault) | brand beside the company name; same site (two products) | NM-ICPS twice |

Uncertain: **CRASTE / Fuma Labs** (same site; crop-residue boards and stubble management),
**NatureX AI Technologies / Naturex Technologies LLP** (control systems vs hydroponics IoT),
**Logy.AI / Mydentist.AI** (same site, different screening apps), **Emflux Motors / Flux
Motors** (different vehicles; probably two companies).

Not duplicates: Agnit / Rana Semiconductors, Anvi / V Robotics, Arc / Ixar Robotics, Arc /
TC Robotics, Ayata / Banyan Intelligence, Dr Mak / RAR Engineering, JAL / Rana
Semiconductors, Kineshia / Kinesthetiq Robotics, Skyx / SSKY Aerospace; and three pairs that
share a website because a source gave one company another's address (Ammsemi /
Inclusiveminds, Indigenous Energy Storage / Ingenium Education, and Cyronics / Iotina, both
given zaubacorp.com).

## What the existing rule would need

10 of the 18 differ only by words the automatic key keeps ("India", "Technologies",
"Innovation(s)", "and"/"&"): Ai Health Highway, Manastik, Module, Mythyaverse, Seismic
Hazard, Stealthera, Umarobotics, Vayunotics, Veritometrics, Vidcare. Stripping those words
from the key would fold them, but it would also fold two different companies that share the
rest of a name, so it is a rule for a person to agree, not a default. The other 8 need hand
entries in `ingest/aliases.json`.
