"use strict";

/*
 * PS1 Audio Converter
 *
 * WAV PCM 16-bit / 44,100 Hz / Stereo
 *                  ↓
 *          RAW CD-DA BIN + CUE
 *
 * El WAV se procesa por bloques para poder trabajar
 * con archivos grandes sin cargar todo el archivo de una vez.
 */

const CDDA_SECTOR_SIZE = 2352;
const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE;

// 44100 samples/sec / 75 sectores/sec = 588 frames/sector
const FRAMES_PER_SECTOR = 588;

const BYTES_PER_SECOND =
    SAMPLE_RATE * BYTES_PER_FRAME;

const BYTES_PER_SECTOR =
    FRAMES_PER_SECTOR * BYTES_PER_FRAME;

if (BYTES_PER_SECTOR !== CDDA_SECTOR_SIZE) {
    throw new Error(
        "Error interno: CDDA debe utilizar exactamente 2352 bytes por sector."
    );
}


/* ============================================================
   ELEMENTOS DE LA INTERFAZ
   ============================================================ */

const audioFileInput = document.getElementById("audioFile");
const convertButton = document.getElementById("convertButton");
const fileInfo = document.getElementById("fileInfo");
const statusText = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const downloads = document.getElementById("downloads");

let selectedFile = null;
let wavInfo = null;


/* ============================================================
   SELECCIÓN DEL ARCHIVO
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

    fileInfo.innerHTML =
        `<strong>${escapeHtml(selectedFile.name)}</strong>`;

    statusText.textContent =
        "Analizando estructura WAV...";

    try {
        wavInfo = await parseWav(selectedFile);

        showWavInformation(wavInfo);

        if (!isCompatibleWav(wavInfo)) {
            statusText.textContent =
                "❌ El WAV no cumple los requisitos de CD-DA.";

            return;
        }

        statusText.textContent =
            "✅ WAV compatible. Listo para convertir.";

        convertButton.disabled = false;

    } catch (error) {
        console.error(error);

        fileInfo.innerHTML = `
            <strong>❌ Error al analizar WAV</strong><br>
            ${escapeHtml(error.message)}
        `;

        statusText.textContent =
            "No se pudo analizar el archivo.";

        convertButton.disabled = true;
    }
});


/* ============================================================
   BOTÓN CONVERTIR
   ============================================================ */

convertButton.addEventListener("click", async () => {
    if (!selectedFile || !wavInfo) {
        return;
    }

    convertButton.disabled = true;

    downloads.innerHTML = "";
    progressBar.style.width = "0%";

    try {
        await convertWavToCdda(
            selectedFile,
            wavInfo
        );

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

/*
 * Esta función NO busca la palabra "data" a ciegas.
 *
 * Recorre los chunks RIFF de manera estructurada:
 *
 * RIFF
 * WAVE
 * fmt
 * LIST
 * JUNK
 * fact
 * ...
 * data
 *
 * De esta forma evitamos encontrar accidentalmente los bytes
 * "data" dentro de metadata.
 */

async function parseWav(file) {
    if (file.size < 12) {
        throw new Error(
            "El archivo es demasiado pequeño para ser un WAV."
        );
    }

    const header = new DataView(
        await file.slice(0, 12).arrayBuffer()
    );

    const riffId =
        readFourCC(header, 0);

    const waveId =
        readFourCC(header, 8);

    if (riffId !== "RIFF") {
        throw new Error(
            `Firma incorrecta: se esperaba RIFF y se encontró "${riffId}".`
        );
    }

    if (waveId !== "WAVE") {
        throw new Error(
            `Formato incorrecto: se esperaba WAVE y se encontró "${waveId}".`
        );
    }

    let offset = 12;

    let fmt = null;
    let dataOffset = null;
    let dataSize = null;

    /*
     * Leemos cada encabezado de chunk individualmente.
     * No importa que el WAV tenga cientos de MB:
     * aquí solo estamos recorriendo sus metadatos.
     */

    while (offset + 8 <= file.size) {

        const chunkHeaderBuffer =
            await file
                .slice(offset, offset + 8)
                .arrayBuffer();

        if (chunkHeaderBuffer.byteLength !== 8) {
            throw new Error(
                "No se pudo leer un encabezado de chunk WAV."
            );
        }

        const chunkHeader =
            new DataView(chunkHeaderBuffer);

        const chunkId =
            readFourCC(chunkHeader, 0);

        const chunkSize =
            chunkHeader.getUint32(4, true);

        const chunkDataOffset =
            offset + 8;

        /*
         * Comprobación contra archivos corruptos.
         */
        if (chunkDataOffset > file.size) {
            throw new Error(
                `Chunk "${chunkId}" fuera de los límites del archivo.`
            );
        }

        if (chunkSize > file.size - chunkDataOffset) {
            throw new Error(
                `El chunk "${chunkId}" declara más datos de los que existen.`
            );
        }

        if (chunkId === "fmt ") {

            if (chunkSize < 16) {
                throw new Error(
                    "El chunk fmt tiene menos de 16 bytes."
                );
            }

            /*
             * Normalmente son solo 16 bytes para PCM.
             * No necesitamos leer todo el chunk si es más grande.
             */
            const fmtSize =
                Math.min(chunkSize, 64);

            const fmtBuffer =
                await file
                    .slice(
                        chunkDataOffset,
                        chunkDataOffset + fmtSize
                    )
                    .arrayBuffer();

            const fmtView =
                new DataView(fmtBuffer);

            const audioFormat =
                fmtView.getUint16(0, true);

            const channels =
                fmtView.getUint16(2, true);

            const sampleRate =
                fmtView.getUint32(4, true);

            const byteRate =
                fmtView.getUint32(8, true);

            const blockAlign =
                fmtView.getUint16(12, true);

            const bitsPerSample =
                fmtView.getUint16(14, true);

            fmt = {
                audioFormat,
                channels,
                sampleRate,
                byteRate,
                blockAlign,
                bitsPerSample
            };
        }

        if (chunkId === "data") {
            dataOffset = chunkDataOffset;
            dataSize = chunkSize;
            break;
        }

        /*
         * RIFF alinea chunks a un número par de bytes.
         */
        const paddedChunkSize =
            chunkSize + (chunkSize & 1);

        const nextOffset =
            chunkDataOffset + paddedChunkSize;

        if (nextOffset <= offset) {
            throw new Error(
                "Se detectó un desplazamiento inválido dentro del WAV."
            );
        }

        offset = nextOffset;

        /*
         * Protección contra archivos dañados.
         */
        if (offset > file.size) {
            throw new Error(
                `El chunk "${chunkId}" apunta fuera del archivo.`
            );
        }

        /*
         * Cuando ya tenemos fmt y llegamos a data,
         * el bucle termina arriba.
         */
    }

    if (!fmt) {
        throw new Error(
            'No se encontró el chunk "fmt ".'
        );
    }

    if (dataOffset === null || dataSize === null) {
        throw new Error(
            'No se encontró un chunk "data" válido.'
        );
    }

    /*
     * Verificación final.
     */
    if (dataOffset + dataSize > file.size) {
        throw new Error(
            "Los datos PCM superan el tamaño físico del archivo."
        );
    }

    return {
        ...fmt,
        dataOffset,
        dataSize
    };
}


/* ============================================================
   VALIDACIÓN DEL WAV
   ============================================================ */

function isCompatibleWav(info) {

    /*
     * audioFormat:
     * 1 = PCM lineal
     */
    if (info.audioFormat !== 1) {
        return false;
    }

    if (info.channels !== CHANNELS) {
        return false;
    }

    if (info.sampleRate !== SAMPLE_RATE) {
        return false;
    }

    if (info.bitsPerSample !== BITS_PER_SAMPLE) {
        return false;
    }

    if (info.blockAlign !== BYTES_PER_FRAME) {
        return false;
    }

    if (info.byteRate !== BYTES_PER_SECOND) {
        return false;
    }

    return true;
}


/* ============================================================
   INFORMACIÓN DEL WAV
   ============================================================ */

function showWavInformation(info) {

    const durationSeconds =
        info.dataSize / BYTES_PER_SECOND;

    const sectorCount =
        Math.ceil(
            info.dataSize /
            CDDA_SECTOR_SIZE
        );

    const expectedBinSize =
        sectorCount *
        CDDA_SECTOR_SIZE;

    fileInfo.innerHTML = `
        <strong>${escapeHtml(selectedFile.name)}</strong><br>
        Tamaño: ${formatBytes(selectedFile.size)}<br>
        Audio: ${
            info.audioFormat === 1
                ? "PCM"
                : `Formato ${info.audioFormat}`
        }<br>
        Canales: ${info.channels}<br>
        Frecuencia: ${info.sampleRate.toLocaleString()} Hz<br>
        Profundidad: ${info.bitsPerSample}-bit<br>
        Datos PCM: ${formatBytes(info.dataSize)}<br>
        Duración: ${formatDuration(durationSeconds)}<br>
        Sectores CDDA: ${sectorCount.toLocaleString()}<br>
        BIN esperado: ${formatBytes(expectedBinSize)}
    `;
}


/* ============================================================
   WAV → CDDA
   ============================================================ */

async function convertWavToCdda(file, info) {

    statusText.textContent =
        "Calculando imagen CD-DA...";

    progressBar.style.width = "0%";

    /*
     * Un sector de CD-DA contiene:
     *
     * 588 frames
     *
     * Cada frame:
     *
     * 2 canales × 16 bits
     *
     * 588 × 2 × 2 = 2352 bytes
     */

    const sectorCount =
        Math.ceil(
            info.dataSize /
            CDDA_SECTOR_SIZE
        );

    const outputSize =
        sectorCount *
        CDDA_SECTOR_SIZE;

    /*
     * Leemos exactamente múltiplos razonables de 2352.
     *
     * 4 MB no es múltiplo exacto de 2352, así que
     * mantenemos un pequeño "carry" entre bloques.
     */
    const READ_SIZE =
        4 * 1024 * 1024;

    const outputParts = [];

    let sourceOffset =
        info.dataOffset;

    let remaining =
        info.dataSize;

    let carry =
        new Uint8Array(0);

    let processed =
        0;

    while (remaining > 0) {

        const readSize =
            Math.min(
                READ_SIZE,
                remaining
            );

        const buffer =
            await file
                .slice(
                    sourceOffset,
                    sourceOffset + readSize
                )
                .arrayBuffer();

        const incoming =
            new Uint8Array(buffer);

        /*
         * Unimos el resto del bloque anterior
         * con el bloque actual.
         */
        let combined;

        if (carry.length === 0) {

            combined =
                incoming;

        } else {

            combined =
                new Uint8Array(
                    carry.length +
                    incoming.length
                );

            combined.set(
                carry,
                0
            );

            combined.set(
                incoming,
                carry.length
            );
        }

        /*
         * Solo producimos sectores completos.
         */
        const completeBytes =
            Math.floor(
                combined.length /
                CDDA_SECTOR_SIZE
            ) * CDDA_SECTOR_SIZE;

        if (completeBytes > 0) {

            const complete =
                combined.subarray(
                    0,
                    completeBytes
                );

            /*
             * Copiamos el bloque para que no dependa
             * del buffer original.
             */
            outputParts.push(
                new Uint8Array(complete)
            );
        }

        /*
         * Guardamos lo que no alcanzó a formar un sector.
         */
        carry =
            combined.slice(
                completeBytes
            );

        sourceOffset += readSize;
        remaining -= readSize;
        processed += readSize;

        const percent =
            (processed /
                info.dataSize) *
            100;

        const visiblePercent =
            Math.min(
                99,
                percent
            );

        progressBar.style.width =
            `${visiblePercent.toFixed(1)}%`;

        statusText.textContent =
            `Generando CD-DA... ${visiblePercent.toFixed(1)}%`;

        /*
         * Permitimos que Chrome actualice la interfaz.
         */
        await yieldToBrowser();
    }

    /*
     * El último sector puede estar incompleto.
     *
     * Lo rellenamos con cero = silencio.
     */
    if (carry.length > 0) {

        const lastSector =
            new Uint8Array(
                CDDA_SECTOR_SIZE
            );

        lastSector.set(
            carry
        );

        outputParts.push(
            lastSector
        );
    }

    /*
     * Comprobaciones.
     */

    let generatedSize = 0;

    for (const part of outputParts) {
        generatedSize +=
            part.byteLength;
    }

    if (
        generatedSize %
        CDDA_SECTOR_SIZE !==
        0
    ) {
        throw new Error(
            `El BIN no está alineado a ${CDDA_SECTOR_SIZE} bytes.`
        );
    }

    if (generatedSize !== outputSize) {
        throw new Error(
            `Tamaño BIN incorrecto. ` +
            `Esperado: ${outputSize}, ` +
            `generado: ${generatedSize}.`
        );
    }

    /*
     * El BIN empieza directamente con audio PCM.
     *
     * NO incluimos:
     * RIFF
     * WAVE
     * fmt
     * data
     */
    const binBlob =
        new Blob(
            outputParts,
            {
                type:
                    "application/octet-stream"
            }
        );

    const baseName =
        removeExtension(
            file.name
        );

    const binName =
        `${baseName}.bin`;

    const cueName =
        `${baseName}.cue`;

    /*
     * Una única pista AUDIO.
     */
    const cueText =
        createCue(
            binName
        );

    const cueBlob =
        new Blob(
            [cueText],
            {
                type:
                    "text/plain;charset=utf-8"
            }
        );

    /*
     * Mostrar descargas.
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

    progressBar.style.width =
        "100%";

    const duration =
        info.dataSize /
        BYTES_PER_SECOND;

    statusText.textContent =
        `✅ Conversión terminada — ${formatDuration(duration)}.`;

    const summary =
        document.createElement(
            "div"
        );

    summary.className =
        "conversion-summary";

    summary.innerHTML = `
        <br>
        <strong>Imagen creada correctamente</strong><br>
        BIN: ${formatBytes(generatedSize)}<br>
        Sectores: ${sectorCount.toLocaleString()}<br>
        Tamaño por sector: ${CDDA_SECTOR_SIZE} bytes<br>
        Audio: PCM 16-bit estéreo<br>
        Frecuencia: ${SAMPLE_RATE.toLocaleString()} Hz<br>
        Tipo: CD-DA RAW
    `;

    downloads.appendChild(
        summary
    );
}


/* ============================================================
   CUE
   ============================================================ */

function createCue(binName) {

    /*
     * El CUE debe estar junto al BIN.
     *
     * Ejemplo:
     *
     * FILE "cancion.bin" BINARY
     *   TRACK 01 AUDIO
     *     INDEX 01 00:00:00
     */

    const safeName =
        binName
            .replaceAll(
                '"',
                '""'
            );

    return [
        `FILE "${safeName}" BINARY`,
        `  TRACK 01 AUDIO`,
        `    INDEX 01 00:00:00`,
        ""
    ].join("\n");
}


/* ============================================================
   DESCARGAS
   ============================================================ */

function createDownload(
    blob,
    filename,
    text
) {
    const url =
        URL.createObjectURL(
            blob
        );

    const link =
        document.createElement(
            "a"
        );

    link.href =
        url;

    link.download =
        filename;

    link.className =
        "download";

    link.textContent =
        text;

    downloads.appendChild(
        link
    );
}


/* ============================================================
   UTILIDADES WAV
   ============================================================ */

function readFourCC(
    view,
    offset
) {
    return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
    );
}


/* ============================================================
   UTILIDADES GENERALES
   ============================================================ */

function removeExtension(
    filename
) {
    return filename.replace(
        /\.[^/.]+$/,
        ""
    );
}


function formatBytes(
    bytes
) {
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
        Math.pow(
            1024,
            exponent
        );

    return (
        `${value.toFixed(2)} ` +
        `${units[exponent]}`
    );
}


function formatDuration(
    seconds
) {
    const total =
        Math.max(
            0,
            Math.floor(seconds)
        );

    const hours =
        Math.floor(
            total / 3600
        );

    const minutes =
        Math.floor(
            (total % 3600) /
            60
        );

    const secs =
        total % 60;

    if (hours > 0) {
        return (
            `${hours}:` +
            `${String(minutes).padStart(2, "0")}:` +
            `${String(secs).padStart(2, "0")}`
        );
    }

    return (
        `${minutes}:` +
        `${String(secs).padStart(2, "0")}`
    );
}


function escapeHtml(
    value
) {
    return String(value)
        .replaceAll(
            "&",
            "&amp;"
        )
        .replaceAll(
            "<",
            "&lt;"
        )
        .replaceAll(
            ">",
            "&gt;"
        )
        .replaceAll(
            '"',
            "&quot;"
        )
        .replaceAll(
            "'",
            "&#039;"
        );
}


/* ============================================================
   MANTENER RESPONSIVA LA PÁGINA
   ============================================================ */

function yieldToBrowser() {
    return new Promise(
        resolve => {
            if (
                "requestIdleCallback"
                in window
            ) {
                requestIdleCallback(
                    () => resolve(),
                    {
                        timeout: 50
                    }
                );
            } else {
                setTimeout(
                    resolve,
                    0
                );
            }
        }
    );
}
