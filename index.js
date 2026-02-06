require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits, Events 
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- 1. KONFIGURÁCIÓ ---
const LIMITS = {
    1: 15,       // Rang 1
    2: 30,       // Rang 2
    3: Infinity  // Rang 3
};

// --- 2. WEBSZERVER ---
const app = express();
app.get('/', (req, res) => res.send('SteamTools Master Bot Online!'));
app.listen(process.env.PORT || 3000);

// --- 3. ADATBÁZIS ---
mongoose.connect(process.env.MONGODB_URI).catch(err => console.error("MongoDB hiba:", err));

const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    rank: { type: Number, default: 1 }, 
    dailyUsage: { type: Number, default: 0 },
    lastDate: { type: String, default: '' } 
});
const UserModel = mongoose.model('User', UserSchema);

// ÚJ: logChannelId hozzáadva a beállításokhoz
const ConfigSchema = new mongoose.Schema({
    allowedChannels: [String],
    logChannelId: { type: String, default: null } 
});
const ConfigModel = mongoose.model('Config', ConfigSchema);

// --- 4. FORRÁSOK ---
const FIX_SOURCES = {
    online: "https://files.luatools.work/OnlineFix1/",
    ryuu_fixes: "https://generator.ryuu.lol/fixes"
};

const MANIFEST_SOURCES = [
    { name: 'Morrenus', url: (id) => `https://manifest.morrenus.xyz/api/v1/manifest/${id}?api_key=${process.env.MORRENUS_API_KEY}` },
    { name: 'Ryuu', url: (id) => `http://167.235.229.108/${id}` },
    { name: 'Sushi', url: (id) => `https://raw.githubusercontent.com/sushi-dev55-alt/sushitools-games-repo-alt/refs/heads/main/${id}.zip` },
    { name: 'TwentyTwo', url: (id) => `http://masss.pythonanywhere.com/storage?auth=IEOIJE54esfsipoE56GE4&appid=${id}` },
    { name: 'ManifestHub', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` }
];

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
});

// --- 5. SEGÉDFÜGGVÉNYEK ---

async function checkQuota(userId) {
    const today = new Date().toISOString().split('T')[0]; 
    let user = await UserModel.findOne({ userId });

    if (!user) return { allowed: false, error: "❌ Nem vagy hozzáadva a rendszerhez! Kérj engedélyt az admintól." };

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
            if (res.status === 200) {
                return { data: res.data, source: source.name, url: url }; 
            }
        } catch (e) { continue; }
    }
    return null;
}

async function getFile(url, fileName) {
    try {
        const head = await axios.head(url, { timeout: 2500 }).catch(() => null);
        if (!head) return null;
        
        const size = parseInt(head.headers['content-length'] || 0);
        
        // 10 MB LIMIT
        if (size > 10 * 1024 * 1024) return { tooLarge: true, size: (size / 1024 / 1024).toFixed(1) };
        
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

// --- 6. ESEMÉNYEK ---

client.on(Events.InteractionCreate, async interaction => {
    // Autocomplete
    if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused();
        if (!focused) return interaction.respond([]);
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focused)}&l=hungarian&cc=HU`;
        const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
        const suggestions = res.data.items.map(g => ({ name: `${g.name.substring(0, 80)} (${g.id})`, value: g.id.toString() })).slice(0, 20);
        return interaction.respond(suggestions);
    }

    if (!interaction.isChatInputCommand()) return;

    // --- ADMIN PARANCSOK ---
    if (interaction.commandName === 'admin') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && interaction.user.id !== process.env.ADMIN_ID) {
            return interaction.reply({ content: "❌ Nincs jogosultságod!", ephemeral: true });
        }
        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();
        
        // --- FELHASZNÁLÓK ---
        if (group === 'user') {
            const target = interaction.options.getUser('target');
            
            // Hozzáadás
            if (sub === 'add') {
                const rank = interaction.options.getInteger('rank');
                await UserModel.findOneAndUpdate({ userId: target.id }, { userId: target.id, rank: rank }, { upsert: true, new: true });
                return interaction.reply({ content: `✅ **${target.tag}** hozzáadva! Rang: **${rank}**`, ephemeral: true });
            }
            // Törlés
            if (sub === 'remove') {
                await UserModel.findOneAndDelete({ userId: target.id });
                return interaction.reply({ content: `🗑️ **${target.tag}** törölve.`, ephemeral: true });
            }
            // ÚJ: RESET (Nullázás)
            if (sub === 'reset') {
                const user = await UserModel.findOneAndUpdate({ userId: target.id }, { dailyUsage: 0 }, { new: true });
                if (!user) return interaction.reply({ content: "❌ Ez a felhasználó nincs az adatbázisban.", ephemeral: true });
                return interaction.reply({ content: `🔄 **${target.tag}** napi kvótája lenullázva! (0 használat)`, ephemeral: true });
            }
        }

        // --- CSATORNÁK ---
        if (group === 'channel') {
            const targetChannel = interaction.options.getChannel('target') || interaction.channel;
            let config = await ConfigModel.findOne() || await ConfigModel.create({ allowedChannels: [] });
            
            // Engedélyezés (Whitelist)
            if (sub === 'add') {
                if (!config.allowedChannels.includes(targetChannel.id)) {
                    config.allowedChannels.push(targetChannel.id);
                    await config.save();
                    return interaction.reply({ content: `✅ Csatorna engedélyezve (használat): ${targetChannel}`, ephemeral: true });
                }
                return interaction.reply({ content: `⚠️ Már engedélyezve van.`, ephemeral: true });
            }
            // Tiltás
            if (sub === 'remove') {
                config.allowedChannels = config.allowedChannels.filter(id => id !== targetChannel.id);
                await config.save();
                return interaction.reply({ content: `🚫 Csatorna tiltva.`, ephemeral: true });
            }
            // ÚJ: LOG CSATORNA BEÁLLÍTÁS
            if (sub === 'setlog') {
                config.logChannelId = targetChannel.id;
                await config.save();
                return interaction.reply({ content: `📜 **Log Csatorna beállítva:** ${targetChannel}\nIde fogja küldeni a bot, hogy ki mit töltött le.`, ephemeral: true });
            }
        }
    }

    // --- MANIFEST PARANCS ---
    if (interaction.commandName === 'manifest') {
        const sub = interaction.options.getSubcommand();
        const appId = sub === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        
        let config = await ConfigModel.findOne();
        if (config && config.allowedChannels.length > 0 && !config.allowedChannels.includes(interaction.channelId)) {
            return interaction.reply({ content: "❌ Rossz csatorna!", ephemeral: true });
        }

        const quota = await checkQuota(interaction.user.id);
        if (!quota.allowed) return interaction.reply({ content: quota.error, ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`);
            if (!steamRes.data[appId]?.success) return interaction.editReply("❌ Játék nem található.");

            const gameData = steamRes.data[appId].data;
            const fix = await findFixes(appId, gameData.name);
            const zip = await fetchManifestZip(appId);
            
            let attachments = [];
            let statusText = "";

            // 1. MANIFEST (10 MB LIMIT)
            if (zip) {
                if (zip.data.length > 10 * 1024 * 1024) { 
                    const sizeMB = (zip.data.length / 1024 / 1024).toFixed(1);
                    statusText += `⚠️ **Manifest:** Túl nagy (${sizeMB} MB) -> [Letöltés](${zip.url})\n`;
                } else {
                    attachments.push(new AttachmentBuilder(Buffer.from(zip.data), { name: `manifest_${appId}.zip` }));
                    statusText += `✅ **Manifest:** Fájl csatolva\n`;
                }
            } else {
                statusText += `⚠️ **Manifest:** Nincs találat.\n`;
            }

            // 2. ONLINE FIX (10 MB LIMIT)
            if (fix.url) {
                const fileData = await getFile(fix.url, fix.name);
                if (fileData?.attachment) {
                    attachments.push(fileData.attachment);
                    statusText += `✅ **Online Fix:** Fájl csatolva\n`;
                } else if (fileData?.tooLarge) {
                    statusText += `⚠️ **Online Fix:** Túl nagy (${fileData.size} MB) -> [Letöltés](${fix.url})\n`;
                } else {
                    statusText += `🔗 **Online Fix:** [Letöltés](${fix.url})\n`;
                }
            }

            // KVÓTA LEVONÁS
            quota.user.dailyUsage += 1;
            await quota.user.save();
            const remaining = LIMITS[quota.user.rank] === Infinity ? "∞" : LIMITS[quota.user.rank] - quota.user.dailyUsage;
            const quotaText = `Használva: ${quota.user.dailyUsage} | Maradt: ${remaining}`;

            const embed = new EmbedBuilder()
                .setTitle(`📦 ${gameData.name}`)
                .setThumbnail(gameData.header_image)
                .setColor(0x00FF00)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'Fájlok', value: statusText },
                    { name: 'Napi Kvóta', value: quotaText }
                )
                .setFooter({ text: "SteamTools Master" });

            // 3. KÜLDÉS (FAIL-SAFE MÓD)
            try {
                await interaction.editReply({ embeds: [embed], files: attachments });
            } catch (sendError) {
                console.log("Feltöltési hiba, váltás linkre:", sendError.message);
                
                let fallbackText = "";
                if (zip) fallbackText += `🔗 **Manifest:** [LETÖLTÉS LINK](${zip.url})\n`;
                if (fix.url) fallbackText += `🔗 **Online Fix:** [LETÖLTÉS LINK](${fix.url})\n`;
                
                const fallbackEmbed = new EmbedBuilder()
                    .setTitle(`📦 ${gameData.name} (Biztonsági Link Mód)`)
                    .setDescription(`⚠️ **A csomag túl nagy volt a Discordnak.**\nKérlek töltsd le őket innen:\n\n${fallbackText}`)
                    .addFields({ name: 'Napi Kvóta', value: quotaText })
                    .setThumbnail(gameData.header_image)
                    .setColor(0xFFA500);

                await interaction.editReply({ embeds: [fallbackEmbed], files: [] });
            }

            // --- 4. LOG KÜLDÉSE A KÜLÖN CSATORNÁBA (HA BE VAN ÁLLÍTVA) ---
            if (config && config.logChannelId) {
                try {
                    const logChannel = await client.channels.fetch(config.logChannelId);
                    if (logChannel) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle("📜 Játék Lekérés")
                            .setColor(0x3498db)
                            .setThumbnail(gameData.header_image)
                            .addFields(
                                { name: 'Felhasználó', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
                                { name: 'Játék', value: `${gameData.name}`, inline: true },
                                { name: 'AppID', value: `${appId}`, inline: true },
                                { name: 'Kvóta', value: `${quota.user.dailyUsage} db ma`, inline: true }
                            )
                            .setTimestamp();
                        await logChannel.send({ embeds: [logEmbed] });
                    }
                } catch (err) {
                    console.error("Nem sikerült a log küldése:", err.message);
                }
            }
            // -------------------------------------------------------------

        } catch (e) {
            console.error(e);
            await interaction.editReply({ content: "❌ Váratlan hiba történt.", files: [] });
        }
    }
});

// --- 7. START ÉS REGISZTRÁCIÓ ---
client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName('manifest')
            .setDescription('Játék letöltése')
            .addSubcommand(sub => sub.setName('id').setDescription('AppID alapján').addStringOption(o => o.setName('appid').setDescription('AppID').setRequired(true)).addBooleanOption(o => o.setName('dlc').setDescription('DLC?')))
            .addSubcommand(sub => sub.setName('nev').setDescription('Név alapján').addStringOption(o => o.setName('jateknev').setDescription('Név').setRequired(true).setAutocomplete(true)).addBooleanOption(o => o.setName('dlc').setDescription('DLC?'))),
        new SlashCommandBuilder()
            .setName('admin')
            .setDescription('Bot kezelése')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommandGroup(group => group.setName('user').setDescription('Felhasználók')
                .addSubcommand(sub => sub.setName('add').setDescription('Hozzáadás').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true)).addIntegerOption(o => o.setName('rank').setDescription('Rang').setRequired(true).addChoices({ name: 'Rang 1', value: 1 }, { name: 'Rang 2', value: 2 }, { name: 'Rang 3', value: 3 })))
                .addSubcommand(sub => sub.setName('remove').setDescription('Törlés').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true)))
                // ÚJ PARANCS: RESET
                .addSubcommand(sub => sub.setName('reset').setDescription('Kvóta nullázása').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true))))
            .addSubcommandGroup(group => group.setName('channel').setDescription('Csatornák')
                .addSubcommand(sub => sub.setName('add').setDescription('Engedélyezés (Whitelist)').addChannelOption(o => o.setName('target').setDescription('Csatorna')))
                .addSubcommand(sub => sub.setName('remove').setDescription('Tiltás').addChannelOption(o => o.setName('target').setDescription('Csatorna')))
                // ÚJ PARANCS: SETLOG
                .addSubcommand(sub => sub.setName('setlog').setDescription('Log csatorna beállítása').addChannelOption(o => o.setName('target').setDescription('A log csatorna').setRequired(true))))
    ].map(c => c.toJSON());
    const clientId = process.env.CLIENT_ID || client.user.id;
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`✅ Bot online: ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
