# Recording the demo lines

The demo plays one clip per spoken line: the **translation the listener
hears**. Save each file in `apps/telephony-demo/recordings/` with exactly the
name below and restart `npm run demo`; recordings replace the placeholders
automatically.

## Format

- **WAV, signed 16-bit PCM**, mono or stereo, 16 kHz to 48 kHz. In Audacity:
  _File → Export Audio → WAV, Signed 16-bit PCM_. (Windows Sound Recorder saves
  `.m4a`; export or convert to WAV.)
- Quiet room, about 20 cm from the microphone, calm clinical pace.
- Leading and trailing silence is trimmed automatically.
- Synthetic script only — never record a real patient conversation.

## Spanish lines (heard by the patient)

These currently play an English placeholder that says the line is missing.

| File                             | Say exactly                                                          |
| -------------------------------- | -------------------------------------------------------------------- |
| `01-clinician-greeting.wav`      | Hola, soy el doctor Rivera. ¿Qué lo trae por aquí hoy?               |
| `03-clinician-which-side.wav`    | ¿El dolor está en el lado izquierdo o en el lado derecho?            |
| `05-clinician-allergies.wav`     | ¿Es alérgico a algún medicamento?                                    |
| `08-clinician-dose-repeated.wav` | Tome 500 miligramos de acetaminofén cada 8 horas para el dolor.      |
| `10-clinician-follow-up.wav`     | Sí. Regrese mañana por la mañana y llame al 911 si el dolor empeora. |

## English lines (heard by the clinician)

These already play a Windows voice. Record them for a consistent human sound.

| File                        | Say exactly                                  |
| --------------------------- | -------------------------------------------- |
| `02-patient-chest-pain.wav` | I have had chest pain for two days.          |
| `04-patient-left-side.wav`  | On the left side. My arm does not hurt.      |
| `06-patient-penicillin.wav` | Yes, I am allergic to penicillin.            |
| `09-patient-come-back.wav`  | Understood. Do I need to come back tomorrow? |

## Not recorded

`07-clinician-dose-blocked` is scripted to fail the quality gate, so it is
never spoken — exactly what FourPoints does with a translation it cannot
verify.

If you edit `script.json`, keep this list in step with it: every line without
a `FAIL` gate needs a clip named after its `id`.
