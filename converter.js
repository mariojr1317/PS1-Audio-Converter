const audioFile = document.getElementById("audioFile");
const convertButton = document.getElementById("convertButton");

const fileInfo = document.getElementById("fileInfo");
const statusText = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const downloads = document.getElementById("downloads");

let selectedFile = null;

audioFile.addEventListener("change", async () => {

    selectedFile = audioFile.files[0];

    if (!selectedFile) {
        convertButton.disabled = true;
        return;
    }

    fileInfo.textContent =
        `Archivo: ${selectedFile.name} | ` +
        `Tamaño: ${formatBytes(selectedFile.size)}`;

    statusText.textContent = "Analizando WAV...";

    try {

        const header = await readWavHeader(selectedFile);

        fileInfo.innerHTML = `
            <strong>${escapeHtml(selectedFile.name)}</strong><br>
            Tamaño: ${formatBytes(selectedFile.size)}<br>
            Formato: ${header.audioFormat === 1 ? "PCM" : "No PCM"}<br>
            Canales: ${header.channels}<br>
            Frecuencia: ${header.sampleRate} Hz<br>
            Bits: ${header.bitsPerSample}-bit
        `;

        const valid =
            header.audioFormat === 1 &&
            header.channels === 2 &&
            header.sampleRate === 44100 &&
            header.bitsPerSample === 16;

        if (valid) {

            statusText.textContent =
                "✅ WAV compatible. Listo para convertir.";

            convertButton.disabled = false;

        } else {

            statusText.textContent =
                "❌ El WAV no tiene el formato requerido.";

            convertButton.disabled = true;
        }

    } catch (error) {

        console.error(error);

        statusText.textContent =
            "❌ No se pudo leer el WAV.";

        convertButton.disabled = true;
    }
});


convertButton.addEventListener("click", async () => {

    if (!selectedFile) {
        return;
    }

    convertButton.disabled = true;

    downloads.innerHTML = "";

    progressBar.style.width = "0%";

    statusText.textContent =
        "Preparando conversión...";

    try {

        const result = await convertWavToCdda(selectedFile);

        progressBar.style.width = "100%";

        statusText.textContent =
            "✅ Conversión terminada.";

        createDownload(
            result.bin,
            changeExtension(selectedFile.name, ".bin"),
            "💿 Descargar BIN"
        );

        createDownload(
            new Blob(
                [result.cue],
                { type: "text/plain" }
            ),
            changeExtension(selectedFile.name, ".cue"),
            "📄 Descargar CUE"
        );

    } catch (error) {

        console.error(error);

        statusText.textContent =
            "❌ Error durante la conversión.";

    } finally {

        convertButton.disabled = false;
    }
});


async function readWavHeader(file) {

    const buffer = await file.slice(0, 64 * 1024).arrayBuffer();

    const view = new DataView(buffer);

    const riff = readString(view, 0, 4);
    const wave = readString(view, 8, 4);

    if (riff !== "RIFF" || wave !== "WAVE") {
        throw new Error("No es un WAV válido.");
    }

    let offset = 12;

    let audioFormat = null;
    let channels = null;
    let sampleRate = null;
    let bitsPerSample = null;

    while (offset + 8 <= view.byteLength) {

        const chunkId = readString(view, offset, 4);

        const chunkSize =
            view.getUint32(offset + 4, true);

        const chunkStart = offset + 8;

        if (chunkId === "fmt ") {

            audioFormat =
                view.getUint16(chunkStart, true);

            channels =
                view.getUint16(chunkStart + 2, true);

            sampleRate =
                view.getUint32(chunkStart + 4, true);

            bitsPerSample =
                view.getUint16(chunkStart + 14, true);

        }

        offset =
            chunkStart +
            chunkSize +
            (chunkSize % 2);
    }

    return {
        audioFormat,
        channels,
        sampleRate,
        bitsPerSample
    };
}


async function convertWavToCdda(file) {

    /*
     * CDDA utiliza sectores de 2352 bytes.
     *
     * 2352 bytes =
     * 588 muestras estéreo
     *
     * porque:
     *
     * 588 × 2 canales × 2 bytes = 2352
     */

    const CHUNK_SIZE = 4 * 1024 * 1024;

    const outputParts = [];

    let position = 44;

    const audioSize =
        file.size - position;

    let processed = 0;

    while (position < file.size) {

        const end =
            Math.min(
                position + CHUNK_SIZE,
                file.size
            );

        const chunk =
            await file.slice(
                position,
                end
            ).arrayBuffer();

        outputParts.push(chunk);

        position = end;

        processed =
            position - 44;

        const percent =
            Math.min(
                99,
                (processed / audioSize) * 100
            );

        progressBar.style.width =
            `${percent.toFixed(1)}%`;

        statusText.textContent =
            `Procesando audio... ${percent.toFixed(1)}%`;

        await new Promise(
            resolve => setTimeout(resolve, 0)
        );
    }

    /*
     * Por ahora conservamos los datos PCM.
     *
     * En la siguiente versión vamos a construir
     * correctamente los sectores CDDA y el CUE.
     */

    const bin = new Blob(
        outputParts,
        {
            type: "application/octet-stream"
        }
    );

    const duration =
        audioSize / (44100 * 2 * 2);

    const frames =
        Math.ceil(duration * 75);

    const minutes =
        Math.floor(frames / (75 * 60));

    const seconds =
        Math.floor(
            (frames % (75 * 60)) / 75
        );

    const cue =
`FILE "${changeExtension(file.name, ".bin")}" BINARY
  TRACK 01 AUDIO
    INDEX 01 00:00:00
`;

    return {
        bin,
        cue
    };
}


function createDownload(blob, filename, text) {

    const url =
        URL.createObjectURL(blob);

    const link =
        document.createElement("a");

    link.href = url;

    link.download = filename;

    link.className = "download";

    link.textContent = text;

    downloads.appendChild(link);
}


function changeExtension(filename, extension) {

    return filename.replace(
        /\.[^/.]+$/,
        extension
    );
}


function formatBytes(bytes) {

    const units = [
        "B",
        "KB",
        "MB",
        "GB"
    ];

    let i = 0;

    while (
        bytes >= 1024 &&
        i < units.length - 1
    ) {

        bytes /= 1024;
        i++;
    }

    return `${bytes.toFixed(2)} ${units[i]}`;
}


function readString(view, offset, length) {

    let result = "";

    for (let i = 0; i < length; i++) {

        result += String.fromCharCode(
            view.getUint8(offset + i)
        );
    }

    return result;
}


function escapeHtml(text) {

    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
