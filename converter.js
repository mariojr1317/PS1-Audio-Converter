"use strict";

/*
 * PS1 Audio Converter
 * WAV PCM 16-bit / 44.1 kHz / Stereo
 *                         ↓
 *               CD-DA RAW BIN + CUE
 *
 * IMPORTANTE:
 * - El WAV fuente NO se modifica.
 * - El BIN contiene únicamente audio PCM RAW.
 * - Cada sector CD-DA contiene exactamente 2352 bytes.
 * - 2352 bytes = 588 muestras estéreo de 16 bits.
 */

const CDDA_SECTOR_SIZE = 2352;
const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const SAMPLES_PER_SECTOR = 588;

const EXPECTED_BYTES_PER_SECOND =
    SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

const EXPECTED_BYTES_PER_SECTOR =
    SAMPLES_PER_SECTOR * CHANNELS * BYTES_PER_SAMPLE;

// Debe ser exactamente 2352.
if (EXPECTED_BYTES_PER_SECTOR !== CDDA_SECTOR_SIZE) {
    throw new Error("Error interno: tamaño de sector CDDA incorrecto.");
}

const audioFileInput = document.getElementById("audioFile");
const convertButton = document.getElementById("convertButton");
const fileInfo = document.getElementById("fileInfo");
const statusText = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const downloads = document.getElementById("downloads");

let selectedFile = null;
let wavInfo = null;


/* ============================================================
   EVENTOS
   ============================================================ */

audioFileInput.addEventListener("change", async () => {
    selectedFile = audioFileInput.files?.[0] ?? null;
    wavInfo = null;
    downloads.innerHTML = "";
    progressBar.style.width = "0%";

    if (!selectedFile) {
        convertButton.disabled = true;
        fileInfo.textContent = "Ningún archivo seleccionado.";
        statusText.textContent = "Esperando archivo...";
        return;
    }

    convertButton.disabled = true;
    statusText.textContent = "Analizando WAV...";

    try {
        wavInfo = await parseWavHeader(selectedFile);

        renderWavInformation(wavInfo);

        if (!isCompatibleWav(wavInfo)) {
            statusText.textContent =
                "❌ El WAV no tiene el formato compatible con CD-DA.";
            return;
        }

        statusText.textContent =
            "✅ WAV compatible. Listo para convertir.";

        convertButton.disabled = false;

    } catch (error) {
        console.error(error);

        fileInfo.innerHTML =
            `<strong>❌ Error</strong><br>${escapeHtml(error.message)}`;

        statusText.textContent =
            "No se pudo analizar el WAV.";
    }
});


convertButton.addEventListener("click", async () => {
    if (!selectedFile || !wavInfo) {
        return;
    }

    convertButton.disabled = true;
    downloads.innerHTML = "";

    try {
        await convertWavToCdda(selectedFile, wavInfo);
    } catch (error) {
        console.error(error);

        statusText.textContent =
            `❌ Error: ${error.message}`;

        progressBar.style.width = "0%";

    } finally {
        convertButton.disabled = false;
    }
});


/* ============================================================
   PARSER WAV
   ============================================================ */

async function parseWavHeader(file) {
    /*
     * No leemos los cientos de MB completos.
     * Solamente buscamos los chunks RIFF/WAVE.
     *
     * Un WAV válido puede tener:
     *
     * RIFF
     *   fmt
     *   LIST
     *   JUNK
     *   fact
     *   data
     *
     * Por eso NO debemos asumir que "data" está en una posición fija.
     */

    const MAX_SCAN = Math.min(file.size, 1024 * 1024);
    const buffer = await file.slice(0, MAX_SCAN).arrayBuffer();
    const view = new DataView(buffer);

    if (view.byteLength < 12) {
        throw new Error("El archivo es demasiado pequeño para ser un WAV.");
    }

    const riff = readAscii(view, 0, 4);
    const wave = readAscii(view, 8, 4);

    if (riff !== "RIFF") {
        throw new Error("El archivo no contiene un encabezado RIFF.");
    }

    if (wave !== "WAVE") {
        throw new Error("El archivo RIFF no es un WAVE.");
    }

    let offset = 12;

    let fmt = null;
    let dataOffset = null;
    let dataSize = null;

    while (offset + 8 <= view.byteLength) {
        const chunkId = readAscii(view, offset, 4);
        const chunkSize = view.getUint32(offset + 4, true);
        const chunkDataOffset = offset + 8;

        if (chunkId === "fmt ") {
            if (chunkDataOffset + chunkSize > view.byteLength) {
                throw new Error("El chunk fmt está incompleto.");
            }

            if (chunkSize < 16) {
                throw new Error("El chunk fmt es inválido.");
            }

            const audioFormat =
                view.getUint16(chunkDataOffset, true);

            const channels =
                view.getUint16(chunkDataOffset + 2, true);

            const sampleRate =
                view.getUint32(chunkDataOffset + 4, true);

            const byteRate =
                view.getUint32(chunkDataOffset + 8, true);

            const blockAlign =
                view.getUint16(chunkDataOffset + 12, true);

            const bitsPerSample =
                view.getUint16(chunkDataOffset + 14, true);

            let validBitsPerSample = bitsPerSample;
            let channelMask = null;

            /*
             * WAV extensible:
             * AudioFormat = 0xFFFE
             *
             * Para nuestro convertidor solo aceptaremos PCM
             * clásico (1), porque el usuario ya tiene el WAV
             * preparado como PCM 16-bit.
             */

            fmt = {
                audioFormat,
                channels,
                sampleRate,
                byteRate,
                blockAlign,
                bitsPerSample,
                validBitsPerSample,
                channelMask
            };
        }

        if (chunkId === "data") {
            dataOffset = chunkDataOffset;
            dataSize = chunkSize;
            break;
        }

        /*
         * Los chunks RIFF tienen tamaño par.
         * Si el tamaño es impar, se agrega un byte de padding.
         */
        offset =
            chunkDataOffset +
            chunkSize +
            (chunkSize & 1);
    }

    if (!fmt) {
        throw new Error("No se encontró el chunk fmt.");
    }

    if (dataOffset === null || dataSize === null) {
        /*
         * Si el data chunk está después del primer MB,
         * hacemos una búsqueda incremental.
         */
        const found = await findDataChunk(file);

        dataOffset = found.dataOffset;
        dataSize = found.dataSize;
    }

    if (dataOffset + dataSize > file.size) {
        throw new Error(
            "El chunk de audio supera el tamaño real del archivo."
        );
    }

    return {
        ...fmt,
        dataOffset,
        dataSize
    };
}


async function findDataChunk(file) {
    /*
     * Algunos WAV pueden tener metadata antes de "data".
     * Vamos buscando por bloques pequeños.
     */

    const CHUNK = 256 * 1024;

    let scanStart = 0;

    while (scanStart < file.size) {
        const scanEnd = Math.min(
            scanStart + CHUNK,
            file.size
        );

        const buffer = await file
            .slice(scanStart, scanEnd)
            .arrayBuffer();

        const bytes = new Uint8Array(buffer);

        for (let i = 0; i <= bytes.length - 8; i++) {
            if (
                bytes[i] === 0x64 && // d
                bytes[i + 1] === 0x61 && // a
                bytes[i + 2] === 0x74 && // t
                bytes[i + 3] === 0x61    // a
            ) {
                const view = new DataView(
                    buffer,
                    i,
                    bytes.length - i
                );

                if (view.byteLength < 8) {
                    continue;
                }

                const size =
                    view.getUint32(4, true);

                const absoluteOffset =
                    scanStart + i + 8;

                if (
                    absoluteOffset <= file.size &&
                    size <= file.size - absoluteOffset
                ) {
                    return {
                        dataOffset: absoluteOffset,
                        dataSize: size
                    };
                }
            }
        }

        scanStart += CHUNK - 7;
    }

    throw new Error("No se encontró el chunk data.");
}


/* ============================================================
   VALIDACIÓN
   ============================================================ */

function isCompatibleWav(info) {
    return (
        info.audioFormat === 1 &&
        info.channels === 2 &&
        info.sampleRate === SAMPLE_RATE &&
        info.bitsPerSample === 16 &&
        info.blockAlign === 4 &&
        info.byteRate === EXPECTED_BYTES_PER_SECOND
    );
}


function renderWavInformation(info) {
    const durationSeconds =
        info.dataSize / EXPECTED_BYTES_PER_SECOND;

    const sectorCount =
        Math.ceil(
            info.dataSize / CDDA_SECTOR_SIZE
        );

    fileInfo.innerHTML = `
        <strong>${escapeHtml(selectedFile.name)}</strong><br>
        Tamaño: ${formatBytes(selectedFile.size)}<br>
        Audio: ${info.audioFormat === 1 ? "PCM" : "No PCM"}<br>
        Canales: ${info.channels}<br>
        Frecuencia: ${info.sampleRate.toLocaleString()} Hz<br>
        Profundidad: ${info.bitsPerSample}-bit<br>
        Datos de audio: ${formatBytes(info.dataSize)}<br>
        Duración: ${formatDuration(durationSeconds)}<br>
        Sectores CDDA: ${sectorCount.toLocaleString()}
    `;
}


/* ============================================================
   CONVERSIÓN WAV → CDDA BIN
   ============================================================ */

async function convertWavToCdda(file, info) {
    statusText.textContent =
        "Preparando conversión CD-DA...";

    progressBar.style.width = "0%";

    /*
     * Calculamos cuántos bytes reales necesita el BIN.
     *
     * Cada sector CDDA = 2352 bytes.
     */
    const sectorCount =
        Math.ceil(
            info.dataSize / CDDA_SECTOR_SIZE
        );

    const outputSize =
        sectorCount * CDDA_SECTOR_SIZE;

    /*
     * Trabajamos por bloques.
     *
     * No usamos file.arrayBuffer() para todo el WAV.
     * Eso sería muy mala idea con un archivo de 600+ MB.
     */

    const READ_CHUNK_SIZE =
        4 * 1024 * 1024; // 4 MB

    const outputParts = [];

    let sourcePosition = info.dataOffset;
    let remaining = info.dataSize;

    let outputCarry = new Uint8Array(0);

    let processed = 0;

    while (remaining > 0) {
        const amount =
            Math.min(
                READ_CHUNK_SIZE,
                remaining
            );

        const arrayBuffer = await file
            .slice(
                sourcePosition,
                sourcePosition + amount
            )
            .arrayBuffer();

        const incoming =
            new Uint8Array(arrayBuffer);

        /*
         * Unimos cualquier resto del bloque anterior
         * con el bloque actual.
         */
        let combined;

        if (outputCarry.length > 0) {
            combined = new Uint8Array(
                outputCarry.length + incoming.length
            );

            combined.set(outputCarry, 0);
            combined.set(
                incoming,
                outputCarry.length
            );

        } else {
            combined = incoming;
        }

        const completeSize =
            Math.floor(
                combined.length /
                CDDA_SECTOR_SIZE
            ) * CDDA_SECTOR_SIZE;

        if (completeSize > 0) {
            const complete =
                combined.slice(
                    0,
                    completeSize
                );

            outputParts.push(complete);

            outputCarry =
                combined.slice(completeSize);
        } else {
            outputCarry = combined;
        }

        sourcePosition += amount;
        remaining -= amount;
        processed += amount;

        const percent =
            (processed / info.dataSize) * 100;

        progressBar.style.width =
            `${Math.min(percent, 99.5).toFixed(1)}%`;

        statusText.textContent =
            `Generando CD-DA... ${Math.min(percent, 99.5).toFixed(1)}%`;

        /*
         * Cedemos el hilo principal.
         * Esto hace que Chrome no parezca completamente muerto
         * durante un archivo enorme.
         */
        await yieldToBrowser();
    }

    /*
     * Si quedaron bytes incompletos, rellenamos el último sector
     * con silencio digital.
     */
    if (outputCarry.length > 0) {
        const finalSector =
            new Uint8Array(CDDA_SECTOR_SIZE);

        finalSector.set(outputCarry, 0);

        /*
         * Uint8Array nuevo viene inicializado en cero,
         * así que el resto queda en silencio.
         */
        outputParts.push(finalSector);
    }

    /*
     * Seguridad adicional:
     * comprobamos que el tamaño final sea exactamente
     * múltiplo de 2352.
     */
    const finalSize =
        outputParts.reduce(
            (sum, part) => sum + part.byteLength,
            0
        );

    if (finalSize % CDDA_SECTOR_SIZE !== 0) {
        throw new Error(
            "El BIN resultante no está alineado a 2352 bytes."
        );
    }

    if (finalSize !== outputSize) {
        throw new Error(
            "El tamaño final del BIN no coincide con el esperado."
        );
    }

    statusText.textContent =
        "Construyendo archivos BIN + CUE...";

    progressBar.style.width = "99.7%";

    /*
     * IMPORTANTE:
     *
     * El BIN de audio CDDA no tiene header WAV,
     * ni RIFF, ni WAVE, ni fmt, ni data.
     *
     * Contiene directamente los frames PCM.
     */
    const binBlob = new Blob(
        outputParts,
        {
            type: "application/octet-stream"
        }
    );

    const baseName =
        removeExtension(file.name);

    const binName =
        `${baseName}.bin`;

    const cueName =
        `${baseName}.cue`;

    const cueText =
        buildSingleTrackCue(binName);

    const cueBlob =
        new Blob(
            [cueText],
            {
                type: "text/plain;charset=utf-8"
            }
        );

    /*
     * Creamos las descargas.
     */
    createDownload(
        binBlob,
        binName,
        "💿 Descargar BIN"
    );

    createDownload(
        cueBlob,
        cueName,
        "📄 Descargar CUE"
    );

    progressBar.style.width = "100%";

    const duration =
        info.dataSize /
        EXPECTED_BYTES_PER_SECOND;

    statusText.textContent =
        `✅ CD-DA terminado. ${formatDuration(duration)} de audio.`;

    /*
     * Información adicional para depuración.
     */
    const debug = document.createElement("div");

    debug.className = "conversion-summary";

    debug.innerHTML = `
        <br>
        <strong>Resultado:</strong><br>
        BIN: ${formatBytes(finalSize)}<br>
        Sectores: ${sectorCount.toLocaleString()}<br>
        Tamaño de sector: ${CDDA_SECTOR_SIZE} bytes<br>
        Frecuencia: ${SAMPLE_RATE.toLocaleString()} Hz<br>
        Audio: PCM 16-bit estéreo<br>
        Tipo: CD-DA RAW
    `;

    downloads.appendChild(debug);
}


/* ============================================================
   CUE
   ============================================================ */

function buildSingleTrackCue(binFileName) {
    /*
     * Para una única pista de audio:
     *
     * FILE "nombre.bin" BINARY
     *   TRACK 01 AUDIO
     *     INDEX 01 00:00:00
     */

    const safeName =
        binFileName.replaceAll('"', '""');

    return [
        `FILE "${safeName}" BINARY`,
        `  TRACK 01 AUDIO`,
        `    INDEX 01 00:00:00`,
        ``
    ].join("\n");
}


/* ============================================================
   DESCARGAS
   ============================================================ */

function createDownload(blob, filename, label) {
    const url =
        URL.createObjectURL(blob);

    const link =
        document.createElement("a");

    link.href = url;
    link.download = filename;
    link.className = "download";
    link.textContent = label;

    downloads.appendChild(link);

    /*
     * No revocamos inmediatamente el URL,
     * porque el usuario todavía necesita hacer clic.
     */
}


/* ============================================================
   UTILIDADES
   ============================================================ */

function readAscii(view, offset, length) {
    let result = "";

    for (let i = 0; i < length; i++) {
        result += String.fromCharCode(
            view.getUint8(offset + i)
        );
    }

    return result;
}


function removeExtension(filename) {
    return filename.replace(
        /\.[^/.]+$/,
        ""
    );
}


function formatBytes(bytes) {
    if (bytes === 0) {
        return "0 B";
    }

    const units = [
        "B",
        "KB",
        "MB",
        "GB",
        "TB"
    ];

    const exponent =
        Math.min(
            Math.floor(
                Math.log(bytes) /
                Math.log(1024)
            ),
            units.length - 1
        );

    const value =
        bytes /
        Math.pow(1024, exponent);

    return `${value.toFixed(2)} ${units[exponent]}`;
}


function formatDuration(totalSeconds) {
    const total =
        Math.max(
            0,
            Math.floor(totalSeconds)
        );

    const hours =
        Math.floor(total / 3600);

    const minutes =
        Math.floor(
            (total % 3600) / 60
        );

    const seconds =
        total % 60;

    if (hours > 0) {
        return (
            `${hours}:${String(minutes).padStart(2, "0")}:` +
            `${String(seconds).padStart(2, "0")}`
        );
    }

    return (
        `${minutes}:${String(seconds).padStart(2, "0")}`
    );
}


function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


function yieldToBrowser() {
    return new Promise(resolve => {
        if ("requestIdleCallback" in window) {
            requestIdleCallback(
                () => resolve(),
                { timeout: 50 }
            );
        } else {
            setTimeout(resolve, 0);
        }
    });
}
