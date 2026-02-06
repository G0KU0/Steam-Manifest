require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits, Events 
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- KONFIGURÁCIÓ ---
const DISCORD_FILE_LIMIT = 24 * 1024 * 1024; // 24MB (biztonsági pufferrel)

const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000);

mongoose.connect(process.env.MONGODB_URI).catch(err => console.error("MongoDB hiba:", err));
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String]
}));

const FIX_SOURCES = {
    online: "https://files.luatools.work/OnlineFix1/",
    generic: "https://files.luatools.work/GameBypasses/",
    ryuu_fixes: "https://generator.ryuu.lol/fixes"
};

const MANIFEST_SOURCES = [
    { name: 'Morrenus (API)', url: (id) => `https://manifest.morrenus.xyz/api/v1/manifest/${id}?api_key=${process.env.MORRENUS_API_KEY}` },
    { name: 'Ryuu', url: (id) => `http://167.235.229.108/${id}` },
    { name: 'Sushi', url: (id) => `https://raw.githubusercontent.com/sushi-dev55-alt/sushitools-games-repo-alt/refs/heads/main/${id}.zip` }
];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// --- SEGÉDFÜGGVÉNYEK ---

// Letölti a fájlt és AttachmentBuilder-t készít belőle, ha nem túl nagy
async function getFileAttachment(url, fileName) {
    try {
        const head = await axios.head(url).catch(() => null);
        if (!head) return null;

        const size = parseInt(head.headers['content-length'] || 0);
        
        // Ha túl nagy a fájl, nem töltjük le, csak jelezzük
        if (size > DISCORD_FILE_LIMIT) return { tooLarge: true, size: (size / 1024 / 1024).toFixed(2) };

        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
        return { 
            attachment: new AttachmentBuilder(Buffer.from(response.data), { name: fileName }),
            tooLarge: false 
        };
    } catch (e) {
        return null;
    }
}

async function checkFixes(appid, gameName) {
    const results = { generic: null, online: null, ryuu: null };
    try {
        const onlineUrl = `${FIX_SOURCES.online}${appid}.zip`;
        if ((await axios.head(onlineUrl).catch(() => null))?.status === 200) results.online = onlineUrl;

        if (gameName) {
            const cleanName = gameName.replace(/[:™®]/g, ""); 
            const patterns = [`${cleanName} Online Patch - Tested OK.zip`, `${cleanName} - Tested OK.zip`, `${cleanName}.zip` ];
            for (const p of patterns) {
                const url = `${FIX_SOURCES.ryuu_fixes}${encodeURIComponent(p)}`;
                if ((await axios.head(url).catch(() => null))?.status === 200) { results.ryuu = url; break; }
            }
        }
    } catch (e) {}
    return results;
}

// --- ESEMÉNYEK ---

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused();
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focused)}&l=hungarian`;
        const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
        const choices = res.data.items.map(g => ({ name: `${g.name} (${g.id})`, value: g.id.toString() })).slice(0, 15);
        return interaction.respond(choices);
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'manifest') {
        await interaction.deferReply({ ephemeral: true });
        const appId = interaction.options.getString('jateknev');
        
        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`);
            const gameData = steamRes.data[appId].data;

            const fixes = await checkFixes(appId, gameData.name);
            const manifestSources = await axios.get(MANIFEST_SOURCES[1].url(appId), { responseType: 'arraybuffer' }).catch(() => null);

            let attachments = [];
            let fixInfo = "";

            // .LUA fájl generálása
            let lua = `add_app(${appId}, "${gameData.name}")\n`;
            if (gameData.dlc) gameData.dlc.forEach(id => lua += `add_dlc(${id})\n`);
            attachments.push(new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` }));

            // Fixek feldolgozása (Letöltés vagy Link)
            const targetFix = fixes.ryuu || fixes.online;
            if (targetFix) {
                const fixFile = await getFileAttachment(targetFix, `fix_${appId}.zip`);
                if (fixFile && fixFile.attachment) {
                    attachments.push(fixFile.attachment);
                    fixInfo = "✅ **Fix fájl csatolva!**";
                } else if (fixFile?.tooLarge) {
                    fixInfo = `⚠️ **Fix túl nagy (${fixFile.size}MB)**: [Közvetlen letöltés](${targetFix})`;
                } else {
                    fixInfo = `🔗 **Fix link**: [Letöltés](${targetFix})`;
                }
            }

            const embed = new EmbedBuilder()
                .setTitle(`📦 ${gameData.name}`)
                .setThumbnail(gameData.header_image)
                .setColor(0x00FF00)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'Online Fix állapot', value: fixInfo || "❌ Nem található" }
                );

            await interaction.editReply({ embeds: [embed], files: attachments });

        } catch (e) { await interaction.editReply("❌ Hiba történt."); }
    }
});

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder().setName('manifest').setDescription('Online Fix és LUA')
            .addStringOption(o => o.setName('jateknev').setDescription('Név...').setRequired(true).setAutocomplete(true))
    ].map(c => c.toJSON());
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
});

client.login(process.env.DISCORD_TOKEN);
