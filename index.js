require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits, Events, ChannelType 
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- KONFIGURÁCIÓ ---
const LIMITS = {
    1: 15,       // Rang 1: Napi 15
    2: 30,       // Rang 2: Napi 30
    3: Infinity  // Rang 3: Végtelen
};

// --- RENDER SZERVER ---
const app = express();
app.get('/', (req, res) => res.send('SteamTools Master Bot Online!'));
app.listen(process.env.PORT || 3000);

// --- ADATBÁZIS ---
mongoose.connect(process.env.MONGODB_URI).catch(err => console.error("MongoDB hiba:", err));

// Felhasználó séma (Rang és Napi használat)
const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    rank: { type: Number, default: 1 }, // 1, 2, vagy 3
    dailyUsage: { type: Number, default: 0 },
    lastDate: { type: String, default: '' } // ÉÉÉÉ-HH-NN formátum
});
const UserModel = mongoose.model('User', UserSchema);

// Beállítások séma (Engedélyezett csatornák)
const ConfigSchema = new mongoose.Schema({
    allowedChannels: [String]
});
const ConfigModel = mongoose.model('Config', ConfigSchema);

// --- FORRÁSOK ---
const FIX_SOURCES = {
    online: "https://files.luatools.work/OnlineFix1/",
    ryuu_fixes: "https://generator.ryuu.lol/fixes"
};

const MANIFEST_SOURCES = [
    { name: 'Morrenus', url: (id) => `https://manifest.morrenus.xyz/api/v1/manifest/${id}?api_key=${process.env.MORRENUS_API_KEY}` },
    { name: 'Ryuu', url: (id) => `http://167.235.229.108/${id}` },
    { name: 'Sushi', url: (id) => `https://raw.githubusercontent.com/sushi-dev55-alt/sushitools-games-repo-alt/refs/heads/main/${id}.zip` },
    { name: 'ManifestHub', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` }
];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// --- SEGÉDFÜGGVÉNYEK ---

async function checkQuota(userId) {
    const today = new Date().toISOString().split('T')[0]; // "2023-10-27"
    let user = await UserModel.findOne({ userId });

    if (!user) return { allowed: false, error: "❌ Nem vagy hozzáadva a rendszerhez!" };

    // Dátum ellenőrzés és reset
    if (user.lastDate !== today) {
        user.dailyUsage = 0;
        user.lastDate = today;
        await user.save();
    }

    const limit = LIMITS[user.rank] || 15;
    if (user.dailyUsage >= limit) {
        return { allowed: false, error: `❌ Elérted a napi limitedet! (${user.dailyUsage}/${limit})` };
    }

    return { allowed: true, user };
}

async function fetchManifestZip(id) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const url = source.url(id);
            const res = await axios({ method: 'get', url: url, responseType: 'arraybuffer', timeout: 3500 });
            if (res.status === 200) return { data: res.data, source: source.name, url: url };
        } catch (e) { continue; }
    }
    return null;
}

async function getFile(url, fileName) {
    try {
        const head = await axios.head(url, { timeout: 2500 }).catch(() => null);
        if (!head) return null;
        const size = parseInt(head.headers['content-length'] || 0);
        if (size > 24 * 1024 * 1024) return { tooLarge: true, size: (size / 1024 / 1024).toFixed(1) };
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        return { attachment: new AttachmentBuilder(Buffer.from(res.data), { name: fileName }) };
    } catch (e) { return null; }
}

async function findFixes(appid, gameName) {
    if (gameName) {
        const clean = gameName.replace(/[:™®]/g, "");
        const patterns = [`${clean} Online Patch - Tested OK.zip`, `${clean} - Tested OK.zip`, `${clean} Online.zip`, `${clean}.zip`];
        for (const p of patterns) {
            const url = `${FIX_SOURCES.ryuu_fixes}/${encodeURIComponent(p)}`;
            const check = await axios.head(url).catch(() => null);
            if (check && check.status === 200) return { url, name: p };
        }
    }
    const onlineUrl = `${FIX_SOURCES.online}${appid}.zip`;
    const checkOnline = await axios.head(onlineUrl).catch(() => null);
    if (checkOnline && checkOnline.status === 200) return { url: onlineUrl, name: `OnlineFix_${appid}.zip` };
    return { url: null, name: "" };
}

// --- ESEMÉNYEK ---

client.on(Events.InteractionCreate, async interaction => {
    
    // --- AUTOCOMPLETE ---
    if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused();
        if (!focused) return interaction.respond([]);
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focused)}&l=hungarian&cc=HU`;
        const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
        const suggestions = res.data.items.map(g => ({ name: `${g.name.substring(0, 80)} (${g.id})`, value: g.id.toString() })).slice(0, 20);
        return interaction.respond(suggestions);
    }

    if (!interaction.isChatInputCommand()) return;

    // --- ADMIN PARANCSOK (/admin) ---
    if (interaction.commandName === 'admin') {
        // Csak Admin használhatja
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && interaction.user.id !== process.env.ADMIN_ID) {
            return interaction.reply({ content: "❌ Nincs jogosultságod!", ephemeral: true });
        }

        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();

        // 1. FELHASZNÁLÓ KEZELÉS
        if (group === 'user') {
            const target = interaction.options.getUser('target');
            
            if (sub === 'add') {
                const rank = interaction.options.getInteger('rank');
                await UserModel.findOneAndUpdate(
                    { userId: target.id },
                    { userId: target.id, rank: rank },
                    { upsert: true, new: true }
                );
                return interaction.reply({ content: `✅ **${target.tag}** hozzáadva! Rang: **${rank}** (Limit: ${LIMITS[rank]})`, ephemeral: true });
            }
            
            if (sub === 'remove') {
                await UserModel.findOneAndDelete({ userId: target.id });
                return interaction.reply({ content: `🗑️ **${target.tag}** eltávolítva a rendszerből.`, ephemeral: true });
            }
        }

        // 2. CSATORNA KEZELÉS
        if (group === 'channel') {
            const targetChannel = interaction.options.getChannel('target') || interaction.channel;
            let config = await ConfigModel.findOne() || await ConfigModel.create({ allowedChannels: [] });

            if (sub === 'add') {
                if (!config.allowedChannels.includes(targetChannel.id)) {
                    config.allowedChannels.push(targetChannel.id);
                    await config.save();
                    return interaction.reply({ content: `✅ Csatorna engedélyezve: ${targetChannel}`, ephemeral: true });
                }
                return interaction.reply({ content: `⚠️ Ez a csatorna már engedélyezve van.`, ephemeral: true });
            }

            if (sub === 'remove') {
                config.allowedChannels = config.allowedChannels.filter(id => id !== targetChannel.id);
                await config.save();
                return interaction.reply({ content: `🚫 Csatorna tiltva: ${targetChannel}`, ephemeral: true });
            }
        }
    }

    // --- MANIFEST GENERÁLÁS (/manifest) ---
    if (interaction.commandName === 'manifest') {
        const sub = interaction.options.getSubcommand();
        const appId = sub === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        const includeDlc = interaction.options.getBoolean('dlc') ?? true;

        // 1. Csatorna ellenőrzés
        let config = await ConfigModel.findOne();
        if (config && config.allowedChannels.length > 0 && !config.allowedChannels.includes(interaction.channelId)) {
            return interaction.reply({ content: "❌ Ebben a csatornában nem használhatod a botot!", ephemeral: true });
        }

        // 2. Kvóta ellenőrzés
        const quota = await checkQuota(interaction.user.id);
        if (!quota.allowed) {
            return interaction.reply({ content: quota.error, ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`);
            if (!steamRes.data[appId]?.success) return interaction.editReply("❌ Játék nem található.");

            const gameData = steamRes.data[appId].data;
            const fix = await findFixes(appId, gameData.name);
            const zip = await fetchManifestZip(appId);
            
            let attachments = [];
            let statusText = "";

            // --- Fájlok összeállítása ---

            // Manifest ZIP
            if (zip) {
                if (zip.data.length > 24 * 1024 * 1024) {
                    statusText += `⚠️ **Manifest:** Túl nagy (${(zip.data.length / 1024 / 1024).toFixed(1)}MB) -> [Letöltés](${zip.url})\n`;
                } else {
                    attachments.push(new AttachmentBuilder(Buffer.from(zip.data), { name: `manifest_${appId}.zip` }));
                    statusText += `✅ **Manifest:** Fájl csatolva\n`;
                }
            } else {
                statusText += `⚠️ **Manifest:** Nem található.\n`;
            }

            // Online Fix
            if (fix.url) {
                const fileData = await getFile(fix.url, fix.name);
                if (fileData?.attachment) {
                    attachments.push(fileData.attachment);
                    statusText += `✅ **Online Fix:** Fájl csatolva\n`;
                } else if (fileData?.tooLarge) {
                    statusText += `⚠️ **Online Fix:** Túl nagy -> [Letöltés](${fix.url})`;
                } else {
                    statusText += `🔗 **Online Fix:** [Letöltés](${fix.url})`;
                }
            }

            // Kvóta növelése (Sikeres generálás után)
            quota.user.dailyUsage += 1;
            await quota.user.save();
            const remaining = LIMITS[quota.user.rank] === Infinity ? "∞" : LIMITS[quota.user.rank] - quota.user.dailyUsage;

            const embed = new EmbedBuilder()
                .setTitle(`📦 ${gameData.name}`)
                .setThumbnail(gameData.header_image)
                .setColor(zip ? 0x00FF00 : 0xFFA500)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'Fájlok', value: statusText || "Nincs letölthető fájl." },
                    { name: 'Napi Kvóta', value: `Használva: ${quota.user.dailyUsage} | Maradt: ${remaining}` }
                )
                .setFooter({ text: "SteamTools Master" });

            await interaction.editReply({ embeds: [embed], files: attachments });

        } catch (e) {
            console.error(e);
            await interaction.editReply({ content: "❌ Hiba történt. Lehet, hogy túl nagy a fájl.", files: [] });
        }
    }
});

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    // --- PARANCSOK REGISZTRÁLÁSA ---
    const commands = [
        // Manifest Parancs
        new SlashCommandBuilder()
            .setName('manifest')
            .setDescription('Játék letöltése (Manifest + Fix)')
            .addSubcommand(sub => sub.setName('id').setDescription('AppID alapján').addStringOption(o => o.setName('appid').setRequired(true)).addBooleanOption(o => o.setName('dlc').setDescription('DLC?')))
            .addSubcommand(sub => sub.setName('nev').setDescription('Név alapján').addStringOption(o => o.setName('jateknev').setRequired(true).setAutocomplete(true)).addBooleanOption(o => o.setName('dlc').setDescription('DLC?'))),
        
        // Admin Parancs (Kezelés)
        new SlashCommandBuilder()
            .setName('admin')
            .setDescription('Bot kezelése')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            // Felhasználók
            .addSubcommandGroup(group => group
                .setName('user')
                .setDescription('Felhasználók kezelése')
                .addSubcommand(sub => sub
                    .setName('add')
                    .setDescription('Felhasználó hozzáadása')
                    .addUserOption(o => o.setName('target').setDescription('Kit?').setRequired(true))
                    .addIntegerOption(o => o.setName('rank').setDescription('Rang (1=15, 2=30, 3=Végtelen)').setRequired(true).addChoices(
                        { name: 'Rang 1 (15/nap)', value: 1 },
                        { name: 'Rang 2 (30/nap)', value: 2 },
                        { name: 'Rang 3 (Végtelen)', value: 3 }
                    )))
                .addSubcommand(sub => sub.setName('remove').setDescription('Felhasználó törlése').addUserOption(o => o.setName('target').setRequired(true))))
            // Csatornák
            .addSubcommandGroup(group => group
                .setName('channel')
                .setDescription('Csatornák kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Csatorna engedélyezése').addChannelOption(o => o.setName('target').setDescription('Csatorna (opcionális)')))
                .addSubcommand(sub => sub.setName('remove').setDescription('Csatorna tiltása').addChannelOption(o => o.setName('target').setDescription('Csatorna (opcionális)'))))
    ].map(c => c.toJSON());

    const clientId = process.env.CLIENT_ID || client.user.id;
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`✅ Bot online: ${client.user.tag} - Rendszer aktív!`);
});

client.login(process.env.DISCORD_TOKEN);
