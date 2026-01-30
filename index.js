require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const express = require('express');

// --- RENDER.COM ÉLETBEN TARTÁS ---
const app = express();
app.get('/', (req, res) => res.send('Manifest Bot is online!'));
app.listen(process.env.PORT || 3000);

// --- SLASH PARANCS DEFINÍCIÓ ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Steam manifest letöltése AppID alapján')
        .addStringOption(option => 
            option.setName('appid')
                .setDescription('A játék Steam AppID-ja (pl. 220968)')
                .setRequired(true))
].map(command => command.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- PARANCSOK REGISZTRÁLÁSA ---
client.once('ready', async () => {
    console.log(`Bot bejelentkezve: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Slash parancsok sikeresen regisztrálva!');
    } catch (error) {
        console.error(error);
    }
});

// --- INTERAKCIÓ KEZELÉSE ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'manifest') {
        const appId = interaction.options.getString('appid').trim();

        // Validáció: csak számokat fogadunk el (forrás: CLI script logic)
        if (!/^\d+$/.test(appId)) {
            return interaction.reply({ content: '❌ [ERROR] Kérlek, csak számokat adj meg!', ephemeral: true });
        }

        await interaction.deferReply();

        try {
            // API végpontok az eredeti forrás alapján
            const checkUrl = `https://api.github.com/repos/SteamAutoCracks/ManifestHub/branches/${appId}`;
            const downloadUrl = `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${appId}`;

            // Ellenőrzés
            await axios.get(checkUrl);

            // ZIP letöltése
            const response = await axios({
                method: 'get',
                url: downloadUrl,
                responseType: 'arraybuffer'
            });

            const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: `manifest_${appId}.zip` });

            const embed = new EmbedBuilder()
                .setColor(0x3b82f6)
                .setTitle('STEAM MANIFEST HUB')
                .setDescription(`A(z) **${appId}** manifest fájlja letöltve.`)
                .addFields(
                    { 
                        name: 'DISCLAIMER', 
                        value: 'Ez a szoftver csak tájékoztató jellegű. Nem vállalunk felelősséget a használatból eredő következményekért.' //
                    },
                    { name: 'Forrás', value: 'Manifest Database' } // Módosítva a kérésed szerint
                )
                .setFooter({ text: 'by Szaby | © 2026' }); // Módosítva a kérésed szerint

            await interaction.editReply({ embeds: [embed], files: [attachment] });

        } catch (error) {
            await interaction.editReply({ 
                content: `> MANIFEST NOT FOUND\nNem található manifest a(z) **${appId}** AppID-hoz.` 
            });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
